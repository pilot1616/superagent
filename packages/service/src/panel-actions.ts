import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import { tools } from '../../core/src/engine.js'
import { DomainError, requireCondition, type Approval } from '../../core/src/model.js'
import { invoke, type Envelope } from './ipc.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const controls = ['task_start', 'task_resume', 'task_retry', 'task_stop', 'task_message', 'task_adjust', 'plan_start', 'plan_pause', 'plan_stop', 'accept-result', 'complete-plan'] as const
const controlSchema = z.object({ action: z.enum(controls), params: z.record(z.string(), z.unknown()), confirmation: z.string() }).strict()
const resultSchema = z.object({ ticketId: z.string().min(1), expectedRevision: z.number().int().positive(), kind: z.enum(['artifact', 'code']), content: z.string().trim().min(1).max(30_000) }).strict()
const completionSchema = z.object({ planId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict()

export function panelActions(state: string) {
  const reviews = new Map<string, { id: string; hash: string; expires: number; fingerprint?: string }>()
  const pending = async (): Promise<Approval[]> => {
    const result = await invoke(state, 'admin', 'approvals')
    requireCondition(result.ok, 'RUNTIME_UNAVAILABLE', 'Cannot read pending approvals')
    return result.data as Approval[]
  }
  const approval = async (id: string) => {
    const value = (await pending()).find(entry => entry.id === id)
    requireCondition(value && Date.parse(value.expiresAt) > Date.now(), 'INVALID_STATE', 'Approval is expired or no longer pending')
    return value
  }
  return {
    clear: async () => { reviews.clear(); const result = await invoke(state, 'admin', 'runtime-clear-reviews'); requireCondition(result.ok, 'RUNTIME_UNAVAILABLE', 'Cannot rotate runtime previews') },
    async runtime(method: string, raw: unknown) { return invoke(state, 'admin', method, raw) },
    pending,
    async inspect(raw: unknown) { z.object({}).strict().parse(raw); return invoke(state, 'admin', 'worker-check') },
    async preview(id: string, raw: unknown) {
      const params = z.object({ authorName: z.string().trim().min(1).max(200).optional(), authorEmail: z.string().email().max(320).optional() }).strict().parse(raw)
      let value = await approval(id)
      if (value.kind === 'publish') {
        requireCondition(params.authorName && params.authorEmail, 'INVALID_REQUEST', 'Publication preview requires author name and email')
        const result = await invoke(state, 'admin', 'publish-preview', { id, ...params })
        requireCondition(result.ok, result.error?.code ?? 'INVALID_STATE', result.error?.message ?? 'Cannot preview publication')
        value = await approval(id)
      }
      const context = await invoke(state, 'bridge', value.kind === 'plan' ? 'plan_get' : 'task_get', value.kind === 'plan' ? { planId: value.ticketId } : { ticketId: value.ticketId })
      requireCondition(context.ok, 'RUNTIME_UNAVAILABLE', 'Cannot read approval context')
      for (const [key, review] of reviews) if (review.expires <= Date.now() || review.id === id) reviews.delete(key)
      requireCondition(reviews.size < 100, 'INVALID_STATE', 'Too many open reviews; finish an existing review')
      const reviewId = randomBytes(32).toString('hex')
      const fingerprint = value.kind === 'plan' ? value.details.fingerprint : value.kind === 'publish' ? (value.details.preview as { fingerprint?: string } | undefined)?.fingerprint : undefined
      reviews.set(reviewId, { id, hash: digest(value), expires: Math.min(Date.now() + 300_000, Date.parse(value.expiresAt)), ...(typeof fingerprint === 'string' ? { fingerprint } : {}) })
      return { approval: value, context: context.data, reviewId, canAccept: value.kind !== 'runtime' }
    },
    async decide(id: string, raw: unknown): Promise<Envelope> {
      const params = z.object({ reviewId: z.string(), accept: z.boolean(), confirmation: z.string() }).strict().parse(raw)
      requireCondition(params.confirmation === id, 'FORBIDDEN', 'Type the complete approval ID to confirm')
      const review = reviews.get(params.reviewId)
      requireCondition(review && review.id === id && review.expires > Date.now(), 'INVALID_STATE', 'Preview expired or already used; review again')
      reviews.delete(params.reviewId)
      const current = await approval(id)
      requireCondition(digest(current) === review.hash, 'REVISION_CONFLICT', 'Approval preview changed; review again')
      requireCondition(!params.accept || current.kind !== 'runtime', 'FORBIDDEN', 'Runtime permission expansion is not verified; decline and revise the task')
      return invoke(state, 'admin', 'decide', { id, accept: params.accept, ...(params.accept && review.fingerprint ? { expectedFingerprint: review.fingerprint } : {}) })
    },
    async control(raw: unknown): Promise<Envelope> {
      const { action, params, confirmation } = controlSchema.parse(raw)
      const schema = action === 'accept-result' ? resultSchema : action === 'complete-plan' ? completionSchema : tools[action]
      const validated = schema.parse(params) as Record<string, unknown>
      const target = validated.ticketId ?? validated.planId
      requireCondition(typeof target === 'string' && confirmation === target, 'FORBIDDEN', 'Type the complete target ID to confirm')
      return invoke(state, action.includes('-') ? 'admin' : 'bridge', action, validated)
    },
  }
}

export function panelError(error: unknown): { status: number; message: string } {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { status: 400, message: 'Invalid request fields or JSON' }
  if (error instanceof DomainError) return { status: error.code === 'FORBIDDEN' ? 403 : 409, message: error.message }
  return { status: 503, message: 'Local service unavailable; refresh actual state before retrying a write' }
}
