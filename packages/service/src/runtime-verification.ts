import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { latestAssignment, requireCondition } from '../../core/src/model.js'
import { verificationDefaults, verificationLimitsSchema, verificationSchema, type RuntimeVerification } from '../../executor-codex/src/contracts.js'
import { canonicalJson } from '../../executor-codex/src/profile.js'
import { launchStamp } from '../../executor-codex/src/inspection.js'
import { newVerification, VerificationRunner, verificationScenarios } from '../../executor-codex/src/verification.js'
import { previewRequestSchema, type RuntimeController } from './runtime.js'

const startSchema = previewRequestSchema.extend({ requestId: z.string().min(8).max(150), reviewId: z.string().uuid(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmation: z.string().min(1).max(1024), limits: verificationLimitsSchema }).strict()
const cancelSchema = previewRequestSchema.extend({ id: z.string().uuid(), requestId: z.string().min(8).max(150), confirmation: z.string().min(1).max(1024) }).strict()
export class RuntimeVerificationService {
  private runners = new Map<string, VerificationRunner>()
  private jobs = new Set<Promise<unknown>>()
  constructor(private runtime: RuntimeController) {}
  private requireIdle() {
    const store = this.runtime.store
    requireCondition(!store.tickets().some(ticket => ticket.stopping || ticket.reconciliation || latestAssignment(ticket)?.state === 'running') && !store.effects().some(effect => ['running', 'uncertain'].includes(effect.state)), 'RECONCILIATION_REQUIRED', 'Verification requires no running, stopping or uncertain production tasks', 409)
    requireCondition(!this.runtime.state().verificationRunId, 'INVALID_STATE', 'Another verification is already active', 409)
  }
  preview(raw: unknown) {
    const params = previewRequestSchema.extend({ limits: verificationLimitsSchema.optional() }).strict().parse(raw)
    this.requireIdle()
    const snapshot = this.runtime.snapshot()
    requireCondition(!snapshot.state.quarantine, 'RUNTIME_QUARANTINED', 'Reconcile quarantine before verification', 409)
    return this.runtime.preview('verify', { expectedRevision: params.expectedRevision, repositoryId: params.repositoryId }, { limits: params.limits ?? verificationDefaults, scenarios: verificationScenarios, provider: snapshot.inspection?.provider, model: snapshot.inspection?.model, data: 'Service-generated temporary fixtures only; never live credentials or production tasks', price: 'unknown', tokenBudgetSupported: false, limitation: 'Optional verification stops before model turn because total token budgets cannot be enforced. Verification is not required for human enablement or dispatch.' })
  }
  start(raw: unknown) {
    const params = startSchema.parse(raw)
    const runtime = this.runtime
    const result = runtime.store.once(runtime.config.operatorId, 'runtime-verify', params.requestId, params, () => {
      this.requireIdle()
      requireCondition(params.confirmation === params.repositoryId, 'FORBIDDEN', 'Confirm the exact project')
      const snapshot = runtime.snapshot()
      requireCondition(snapshot.inspection && snapshot.inspection.fingerprint === params.expectedFingerprint && Date.parse(snapshot.inspection.validUntil) > Date.now(), 'RUNTIME_INSPECTION_STALE', 'Check the current environment before verification', 409)
      requireCondition(snapshot.inspection.auth.status === 'configured', 'AUTH_REQUIRED', 'Configure independent Worker model authentication before verification', 409)
      requireCondition(!snapshot.inspection.checks.some(check => check.status === 'failed' || check.status === 'unknown'), 'RUNTIME_UNSUPPORTED', 'Environment inspection has unresolved failures', 409)
      const review = runtime.consumeReview(params.reviewId, 'verify', params.expectedRevision, params.repositoryId)
      requireCondition(canonicalJson((review.detail as { limits: unknown }).limits) === canonicalJson(params.limits), 'VERIFICATION_BUDGET_EXHAUSTED', 'Use exactly the budget displayed in the one-use review', 409)
      const verification = newVerification(params.repositoryId, params.expectedFingerprint, params.limits)
      runtime.beginVerification(verification)
      return { id: verification.id, operationId: randomUUID(), state: verification.state }
    })
    if (!this.runners.has(result.id)) {
      const verification = runtime.store.entity<RuntimeVerification>('runtime_verification', result.id)!
      if (verification.state === 'prepared') {
        const inspection = runtime.snapshot().inspection!
        const stamp = launchStamp(runtime.stateDir, inspection.executable.realpath)
        const runner = new VerificationRunner(runtime.stateDir, verification, inspection, () => {
          requireCondition(runtime.state().verificationRunId === verification.id && runtime.snapshot().inspection?.fingerprint === verification.fingerprint && !runtime.state().quarantine && launchStamp(runtime.stateDir, inspection.executable.realpath) === stamp, 'RUNTIME_FINGERPRINT_CHANGED', 'Verification permit is no longer valid', 409)
        }, value => runtime.finishVerification(value), process => runtime.store.saveEntity('runtime_verification_process', verification.id, process))
        this.runners.set(result.id, runner)
        const job = runner.run().catch(() => { runtime.quarantine('VERIFICATION_INTERRUPTED', []); return undefined }).finally(() => { this.jobs.delete(job); this.runners.delete(result.id) })
        this.jobs.add(job)
      }
    }
    return result
  }
  get active() { return this.runners.size }
  get(raw: unknown) {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(raw)
    const value = this.runtime.store.entity<RuntimeVerification>('runtime_verification', id)
    requireCondition(value && value.repositoryId === this.runtime.state().repositoryId, 'NOT_FOUND', 'Verification does not belong to this project', 404)
    return verificationSchema.parse(value)
  }
  async cancel(raw: unknown) {
    const params = cancelSchema.parse(raw)
    requireCondition(params.confirmation === params.repositoryId && params.repositoryId === this.runtime.state().repositoryId && params.expectedRevision === this.runtime.state().revision, 'REVISION_CONFLICT', 'Confirm the current project and runtime revision', 409)
    this.get({ id: params.id })
    const runner = this.runners.get(params.id)
    requireCondition(runner, 'INVALID_STATE', 'Verification is not running in this daemon; reconcile interrupted work instead', 409)
    await runner.cancel()
    return this.get({ id: params.id })
  }
  async close() { await Promise.allSettled([...this.runners.values()].map(runner => runner.cancel())); await Promise.allSettled([...this.jobs]) }
}
