import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile, rm, lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DomainError, latestAssignment, requireCondition, type Plan } from '../../core/src/model.js'
import type { Engine } from '../../core/src/engine.js'
import { Store, digest } from '../../storage/src/store.js'
import { protectedSource, requireProtectedStorage, resourceHash } from '../../executor-codex/src/capabilities.js'

const targetSchema = z.object({ ticketId: z.string().uuid() }).strict()
const previewSchema = targetSchema.extend({ expectedRevision: z.number().int().positive(), paths: z.array(z.string().min(1).max(4096)).min(1).max(10) }).strict()
const attachSchema = targetSchema.extend({ expectedRevision: z.number().int().positive(), previewId: z.string().uuid(), requestId: z.string().min(8).max(150), confirmation: z.string().uuid() }).strict()
const maxBytes = 32 * 1024 * 1024
export interface TaskMaterial { id: string; name: string; path: string; sha256: string; bytes: number; planId?: string }
interface PlanMaterials { paths: string[]; files: TaskMaterial[] }
interface Preview { id: string; ticketId: string; revision: number; expiresAt: number; files: (Omit<TaskMaterial, 'id' | 'path'> & { source: string })[] }

async function readBounded(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    requireCondition(info.isFile() && info.size <= maxBytes, 'FORBIDDEN', 'References must be regular files no larger than 32 MiB')
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
    requireCondition(length === info.size, 'REVISION_CONFLICT', 'Reference size changed while reading; preview again')
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

export async function executionMaterials(state: string, store: Store, ticketId: string) {
  const files = store.entity<TaskMaterial[]>('task_materials', ticketId) ?? []
  if (files.length) await requireProtectedStorage(state)
  const roots = new Set<string>()
  for (const file of files) {
    if (file.planId) {
      const ticket = store.ticket(ticketId)
      const bundle = store.entity<PlanMaterials>('plan_materials', file.planId)
      requireCondition(ticket?.planId === file.planId && bundle?.files.some(entry => digest(entry) === digest(file)), 'FORBIDDEN', 'Reference does not belong to this goal')
    }
    const root = file.planId ? join(state, 'plan-materials', file.planId) : join(state, 'task-materials', ticketId)
    requireCondition(file.path === join(root, file.id, file.name) && await realpath(file.path) === file.path && (await lstat(file.path)).isFile(), 'FORBIDDEN', 'Task reference snapshot was redirected')
    const contents = await readBounded(file.path)
    requireCondition(contents.length === file.bytes && resourceHash(contents) === file.sha256, 'FORBIDDEN', 'Task reference snapshot changed; inspect before executing')
    roots.add(root)
  }
  return { files, readRoots: [...roots] }
}

export class TaskMaterials {
  private previews = new Map<string, Preview>()
  constructor(private state: string, private store: Store, private engine: Engine, private active: () => ReadonlyMap<string, unknown>) {}
  clear() { this.previews.clear() }
  async preparePlan(plan: Plan) {
    const paths = plan.workflow?.materialPaths ?? []
    const existing = this.store.entity<PlanMaterials>('plan_materials', plan.id)
    const created: TaskMaterial[] = []
    let committed = false
    const discard = async () => {
      if (!committed) for (const file of created) await rm(join(this.state, 'plan-materials', plan.id, file.id), { recursive: true, force: true })
    }
    const members = plan.ticketIds.map(id => this.engine.require(id)).filter(ticket => !ticket.result)
    const ensureIdle = () => {
      const current = this.store.entity<Plan>('plan', plan.id)
      requireCondition(current?.revision === plan.revision && current.version === plan.version && digest(current.workflow?.materialPaths ?? []) === digest(paths), 'REVISION_CONFLICT', 'Goal changed during reference preparation')
      for (const member of members) {
        const attached = this.store.entity<TaskMaterial[]>('task_materials', member.id) ?? []
        if (!paths.length || existing?.files.every(file => attached.some(entry => digest(entry) === digest(file)))) continue
        const ticket = this.engine.require(member.id)
        requireCondition(ticket.revision === member.revision && !ticket.stopping && !ticket.reconciliation && !this.active().has(ticket.id) && latestAssignment(ticket)?.state !== 'running' && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.state !== 'done' && !(effect.kind === 'launch' && effect.state === 'pending')), 'REVISION_CONFLICT', 'Goal execution changed while preparing references')
      }
    }
    try {
      ensureIdle()
      requireCondition(new Set(paths).size === paths.length, 'INVALID_REQUEST', 'Duplicate goal reference paths')
      if (paths.length) await requireProtectedStorage(this.state)
      if (existing) requireCondition(digest(existing.paths) === digest(paths), 'REVISION_CONFLICT', 'Goal reference authorization changed; use a new goal')
      else {
        const sources = new Set<string>()
        let bytes = 0
        for (const path of paths) {
          const source = await realpath(path).catch(() => { throw new DomainError('MATERIAL_SOURCE_UNAVAILABLE', `Cannot read the declared reference: ${path}`, 409) })
          protectedSource(source, this.state, [this.store.repository()!.executionRoot])
          requireCondition(!sources.has(source), 'INVALID_REQUEST', 'Duplicate resolved reference paths')
          sources.add(source)
          const contents = await readBounded(source).catch(error => { if (error instanceof DomainError) throw error; throw new DomainError('MATERIAL_SOURCE_UNAVAILABLE', `Cannot read the declared reference: ${path}`, 409) })
          requireCondition(await realpath(path) === source, 'REVISION_CONFLICT', 'Reference path changed while reading')
          requireCondition((bytes += contents.length) <= maxBytes, 'INVALID_REQUEST', 'Goal references exceed 32 MiB')
          const id = randomUUID(), name = basename(source)
          const directory = join(this.state, 'plan-materials', plan.id, id)
          const file: TaskMaterial = { id, name, path: join(directory, name), sha256: resourceHash(contents), bytes: contents.length, planId: plan.id }
          created.push(file)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await writeFile(file.path, contents, { flag: 'wx', mode: 0o400 })
        }
      }
      const bundle: PlanMaterials = existing ?? { paths: [...paths], files: created }
      for (const file of bundle.files) {
        requireCondition(file.path === join(this.state, 'plan-materials', plan.id, file.id, file.name) && await realpath(file.path) === file.path, 'FORBIDDEN', 'Goal reference snapshot was redirected')
        const contents = await readBounded(file.path)
        requireCondition(contents.length === file.bytes && resourceHash(contents) === file.sha256, 'FORBIDDEN', 'Goal reference snapshot changed')
      }
      ensureIdle()
      return {
        commit: () => {
          ensureIdle()
          const current = this.store.entity<PlanMaterials>('plan_materials', plan.id)
          requireCondition(digest(current ?? null) === digest(existing ?? null), 'REVISION_CONFLICT', 'Goal references were prepared by another request')
          for (const member of members) {
            const files = this.store.entity<TaskMaterial[]>('task_materials', member.id) ?? []
            const missing = bundle.files.filter(file => !files.some(entry => entry.id === file.id))
            requireCondition(files.length + missing.length <= 50, 'INVALID_REQUEST', 'Task reference limit is 50 files')
            if (!missing.length) continue
            this.store.saveEntity('task_materials', member.id, [...files, ...missing])
            const ticket = this.engine.require(member.id)
            ticket.restartThread = true
            this.engine.save(ticket, 'workflow.materials_distributed', { planId: plan.id, files: missing.map(file => ({ id: file.id, name: file.name, sha256: file.sha256 })) })
          }
          if (paths.length && !existing) this.store.saveEntity('plan_materials', plan.id, bundle)
        },
        finish: () => { committed = true },
        discard,
      }
    } catch (error) { await discard(); throw error }
  }
  list(raw: unknown) {
    const { ticketId } = targetSchema.parse(raw)
    this.engine.require(ticketId)
    return { files: this.store.entity<TaskMaterial[]>('task_materials', ticketId) ?? [] }
  }
  private idle(ticketId: string, revision: number) {
    const ticket = this.engine.require(ticketId)
    requireCondition(ticket.revision === revision, 'REVISION_CONFLICT', 'Task changed; review the current task and references again', 409)
    requireCondition(!ticket.result, 'INVALID_STATE', 'Accepted results are immutable; create a new task for new references')
    requireCondition(!ticket.ended || ticket.ended === 'stopped', 'INVALID_STATE', 'Completed tasks cannot receive references')
    requireCondition(!ticket.stopping && !ticket.reconciliation && !this.active().has(ticketId) && latestAssignment(ticket)?.state !== 'running' && !this.store.effects().some(effect => effect.ticketId === ticketId && ['pending', 'running', 'uncertain'].includes(effect.state)), 'INVALID_STATE', 'Stop or finish pending execution and reconcile it before changing task references')
    return ticket
  }
  async preview(raw: unknown) {
    const params = previewSchema.parse(raw)
    await requireProtectedStorage(this.state)
    this.idle(params.ticketId, params.expectedRevision)
    for (const [id, value] of this.previews) if (value.expiresAt <= Date.now()) this.previews.delete(id)
    requireCondition(this.previews.size < 100, 'INVALID_STATE', 'Too many open reference previews')
    const files: Preview['files'] = []
    let bytes = 0
    for (const path of params.paths) {
      requireCondition(path.startsWith('/'), 'INVALID_REQUEST', 'Reference paths must be absolute')
      const source = await realpath(path)
      protectedSource(source, this.state, [this.store.repository()!.executionRoot])
      requireCondition(!files.some(file => file.source === source), 'INVALID_REQUEST', 'Do not attach the same file twice in one preview')
      const contents = await readBounded(source)
      requireCondition((bytes += contents.length) <= maxBytes, 'INVALID_REQUEST', 'Reference batch exceeds 32 MiB')
      files.push({ source, name: basename(source), bytes: contents.length, sha256: resourceHash(contents) })
    }
    this.idle(params.ticketId, params.expectedRevision)
    const preview: Preview = { id: randomUUID(), ticketId: params.ticketId, revision: params.expectedRevision, expiresAt: Date.now() + 300_000, files }
    this.previews.set(preview.id, preview)
    return preview
  }
  async attach(raw: unknown) {
    const params = attachSchema.parse(raw)
    requireCondition(params.confirmation === params.ticketId, 'FORBIDDEN', 'Confirm the complete task ID')
    const receipt = this.store.entity<{ hash: string; result: unknown }>('task_material_receipt', params.requestId)
    if (receipt) { requireCondition(receipt.hash === digest(params), 'REVISION_CONFLICT', 'Request ID was already used with different reference input'); return receipt.result }
    const preview = this.previews.get(params.previewId)
    requireCondition(preview && preview.expiresAt > Date.now() && preview.ticketId === params.ticketId && preview.revision === params.expectedRevision, 'REVISION_CONFLICT', 'Reference preview expired or changed; preview again')
    this.idle(params.ticketId, params.expectedRevision)
    const files: TaskMaterial[] = []
    try {
      for (const entry of preview.files) {
        protectedSource(await realpath(entry.source), this.state, [this.store.repository()!.executionRoot])
        const contents = await readBounded(entry.source)
        requireCondition(contents.length === entry.bytes && resourceHash(contents) === entry.sha256, 'REVISION_CONFLICT', 'Reference content changed after preview; review it again')
        const id = randomUUID()
        const directory = join(this.state, 'task-materials', params.ticketId, id)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const path = join(directory, entry.name)
        files.push({ id, path, name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })
        await writeFile(path, contents, { flag: 'wx', mode: 0o400 })
      }
      const result = this.store.once(this.engine.operatorId, 'task-materials-attach', params.requestId, params, () => {
        requireCondition(preview.expiresAt > Date.now(), 'REVISION_CONFLICT', 'Reference preview expired')
        const ticket = this.idle(params.ticketId, params.expectedRevision)
        const existing = this.store.entity<TaskMaterial[]>('task_materials', ticket.id) ?? []
        requireCondition(existing.length + files.length <= 50, 'INVALID_REQUEST', 'Task reference limit is 50 files')
        this.store.saveEntity('task_materials', ticket.id, [...existing, ...files])
        ticket.restartThread = true
        ticket.revision++
        ticket.updatedAt = new Date().toISOString()
        this.store.save(ticket)
        this.store.audit(ticket.id, 'task.materials_attached', { files, operatorId: this.engine.operatorId })
        const value = { ticketId: ticket.id, revision: ticket.revision, files: [...existing, ...files], executionStarted: false }
        this.store.saveEntity('task_material_receipt', params.requestId, { hash: digest(params), result: value })
        return value
      })
      this.previews.delete(preview.id)
      for (const file of files) if (!result.files.some(entry => entry.id === file.id)) await rm(join(this.state, 'task-materials', params.ticketId, file.id), { recursive: true, force: true }).catch(() => undefined)
      return result
    } catch (error) { for (const file of files) await rm(join(this.state, 'task-materials', params.ticketId, file.id), { recursive: true, force: true }); throw error }
  }
}
