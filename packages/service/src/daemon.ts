import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import { z } from 'zod'
import { Engine, tools } from '../../core/src/engine.js'
import { deleteRecords } from '../../core/src/deletion.js'
import { DomainError, latestAssignment, requireCondition, type Effect, type Plan } from '../../core/src/model.js'
import type { Executor } from '../../core/src/ports.js'
import { Store } from '../../storage/src/store.js'
import { CodexExecutor } from '../../executor-codex/src/executor.js'
import { SUPPORTED_CODEX, codexVersion } from '../../executor-codex/src/probe.js'
import { RuntimeController } from './runtime.js'
import { RuntimeVerificationService } from './runtime-verification.js'
import { answersSchema } from '../../executor-codex/src/approvals.js'
import { acquireLock, readConfig } from './config.js'
import { inspectWorkspace } from './workspace.js'
import { GitLabHttp } from '../../integrations-gitlab/src/api.js'
import { Delivery } from '../../integrations-gitlab/src/delivery.js'
import { pushCommit } from '../../integrations-gitlab/src/workspace.js'
import { validateGitLabProject } from '../../core/src/gitlab.js'
import { candidates } from '../../core/src/scheduler.js'
import { verifyAcceptedCode } from './workspace.js'
import { TaskMaterials } from './materials.js'
import { WorkflowController } from './workflow.js'
import { PlanWorkspaces } from './plan-workspaces.js'

const rpcSchema = z.object({ method: z.string().max(100), params: z.unknown() }).strict()
const equal = (actual: string, expected: string) => Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
async function body(request: IncomingMessage): Promise<unknown> {
  request.setEncoding('utf8')
  let text = ''
  for await (const chunk of request) {
    text += String(chunk)
    requireCondition(Buffer.byteLength(text) <= 100_000, 'INVALID_REQUEST', 'Request exceeds 100 KB')
  }
  return JSON.parse(text)
}
export async function startService(state: string, factory?: (store: Store, engine: Engine) => Executor) {
  const config = await readConfig(state)
  requireCondition(Buffer.byteLength(join(state, 'service.sock')) < 100, 'INVALID_STATE', 'State path is too long for a Unix socket')
  const bridge = `Bearer ${(await readFile(join(state, 'bridge.token'), 'utf8')).trim()}`
  const admin = `Bearer ${(await readFile(join(state, 'admin.token'), 'utf8')).trim()}`
  const lock = await acquireLock(state)
  let store: Store
  try { store = new Store(join(state, 'tasks.sqlite')) } catch (error) { await lock.release(); throw error }
  try {
    const repository = store.repository()
    requireCondition(repository && !('github' in repository) && (!repository.remote || repository.gitlab), 'MIGRATION_REQUIRED', 'Repository state is not registered for GitLab; use a separate initialized state directory')
    if (repository.gitlab) validateGitLabProject(repository.gitlab)
    requireCondition(!store.tickets().some(ticket => 'pull' in ticket || ticket.inputs.some(entry => String(entry.source) === 'github')), 'MIGRATION_REQUIRED', 'Legacy GitHub task history cannot be executed as GitLab state')
  } catch (error) { store.close(); await lock.release(); throw error }
  let runtimeVersion: string | null = null
  try { runtimeVersion = codexVersion() } catch {}
  let runtime: RuntimeController
  try { runtime = new RuntimeController(store, state, config) }
  catch (error) { store.close(); await lock.release(); throw error }
  const verification = new RuntimeVerificationService(runtime)
  const engine = new Engine(store, config.operatorId, undefined, factory ? undefined : runtime)
  const executor = factory?.(store, engine) ?? new CodexExecutor(store, engine, state)
  const materials = new TaskMaterials(state, store, engine, () => executor.active)
  const jobTickets = new Set<string>()
  const workspaces = new PlanWorkspaces(store, engine, () => new Set(executor.active.keys()), () => jobTickets)
  const workflow = new WorkflowController(store, engine, materials, factory ? undefined : runtime, workspaces)
  const gitlab = new GitLabHttp(state, store.repository()?.gitlab)
  const delivery = new Delivery(store, engine, state, gitlab, async (ticket, preview, sha) => pushCommit(ticket, preview, sha, await gitlab.token()))
  engine.recover()
  if (!factory) {
    const uncertain = store.tickets().filter(ticket => ticket.reconciliation && latestAssignment(ticket)?.state === 'running').map(ticket => latestAssignment(ticket)!.id)
    if (uncertain.length) runtime.quarantine('CRASH_RECONCILIATION_REQUIRED', uncertain)
  }
  let closing = false
  const jobs = new Set<Promise<void>>()
  runtime.onSafetyInvalidation = reasonCode => {
    for (const id of executor.active.keys()) {
      const ticket = engine.require(id)
      if (!ticket.mandate.humanHold) engine.call('task_stop', { ticketId: id, expectedRevision: ticket.revision, requestId: randomUUID(), reason: `Runtime safety stop: ${reasonCode}` })
    }
  }
  let observedAt = 0
  let observing = false
  const poll = async () => {
    observing = true
    try {
      for (const ticket of store.tickets()) {
        if (closing) break
        if (!ticket.mergeRequest || ticket.mergeRequest.state !== 'open' || executor.active.has(ticket.id) || store.effects('running').some(effect => effect.ticketId === ticket.id)) continue
        const prior = store.get<{ nextAttempt?: number; failures?: number }>(`gitlab:${ticket.id}`)
        if ((prior?.nextAttempt ?? 0) > Date.now() || (prior?.failures ?? 0) >= 6) continue
        try { await delivery.observe(ticket.id) }
        catch {
          const failures = (prior?.failures ?? 0) + 1
          store.set(`gitlab:${ticket.id}`, { ...prior, failures, nextAttempt: Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 5_000), state: 'read-failed' })
        }
      }
    } finally { observing = false }
  }
  const finish = (effect: Effect, status: Effect['state']) => store.saveEffect({ ...(store.effects().find(entry => entry.key === effect.key) ?? effect), state: status })
  const dispatch = async (effect: Effect) => {
    if (effect.kind === 'launch') {
      const pending = store.ticket(effect.ticketId)
      if (!pending) return
      if (!factory || pending.workspaceBinding) {
        try {
          const prepared = await workspaces.prepare({ ticketId: pending.id, expectedRevision: pending.revision }, true) as { ready: boolean }
          if (!prepared.ready || closing) return
        } catch { return }
      }
    }
    const ticket = engine.claim(effect)
    if (!ticket) return
    try {
      if (effect.kind === 'launch') await executor.launch(ticket)
      else if (effect.kind === 'stop') {
        requireCondition(!store.effects('running').some(entry => entry.ticketId === ticket.id && entry.kind === 'publish'), 'RECONCILIATION_REQUIRED', 'Publication is in flight; cancellation needs external reconciliation')
        await executor.stop(ticket.id)
      } else {
        requireCondition(config.gitlabEnabled, 'RUNTIME_UNAVAILABLE', 'GitLab delivery is disabled in service configuration')
        await delivery.publish(effect)
      }
      finish(effect, 'done')
    } catch (error) {
      if (effect.kind === 'publish') {
        engine.failPublication(effect.key, error instanceof DomainError ? error.message : 'Publication failed; inspect the persisted delivery phase')
        return
      }
      const uncertain = effect.kind !== 'launch' || Boolean(engine.require(ticket.id).reconciliation)
      if (effect.kind === 'launch' && error instanceof DomainError && (error.code === 'PREPARATION_CANCELLED' || error.code.startsWith('RUNTIME_')) && !executor.active.has(ticket.id) && (latestAssignment(engine.require(ticket.id))?.state === 'pending' || engine.cancelPreparation(ticket.id, latestAssignment(ticket)!.id))) return
      if (effect.kind === 'launch') engine.fail(ticket.id, latestAssignment(ticket)!.id, error instanceof DomainError ? error.message : 'Execution failed; inspect the local runtime and recover before retrying', uncertain)
      else store.atomic(() => { const current = engine.require(ticket.id); current.reconciliation = 'External or stop operation is uncertain; inspect before retrying'; current.revision++; store.save(current); store.audit(ticket.id, 'effect.uncertain', { kind: effect.kind }) })
      finish(effect, uncertain ? 'uncertain' : 'done')
    }
  }
  const tick = () => {
    if (closing) return
    if (!lock.owned()) { void close(); return }
    engine.expireApprovals()
    engine.coordination.advanceHandoffs()
    store.atomic(() => {
      for (const ticket of store.tickets()) {
        const decision = engine.decision(ticket, new Set(executor.active.keys()))
        const key = `scheduler:decision:${ticket.id}`
        if (JSON.stringify(store.get(key)) !== JSON.stringify(decision)) { store.set(key, decision); store.audit(ticket.id, 'scheduler.decision', decision) }
      }
    })
    const scheduled = [...store.effects('pending').filter(effect => effect.kind !== 'launch').sort((left, right) => Number(right.kind === 'stop') - Number(left.kind === 'stop')), ...((factory || !runtime.blocker()) ? candidates(store, new Set(executor.active.keys()), jobTickets, config.concurrency) : [])]
    for (const effect of scheduled) {
      if (effect.dueAt > Date.now()) continue
      if (jobTickets.has(effect.ticketId) || (effect.kind !== 'stop' && executor.active.has(effect.ticketId))) continue
      jobTickets.add(effect.ticketId)
      const job = dispatch(effect).finally(() => { jobs.delete(job); jobTickets.delete(effect.ticketId) })
      jobs.add(job)
    }
    if (config.gitlabEnabled && !observing && Date.now() - observedAt >= 60_000) {
      observedAt = Date.now()
      const job = poll().finally(() => jobs.delete(job))
      jobs.add(job)
    }
  }
  const callAdmin = async (method: string, raw: unknown): Promise<unknown> => {
    if (method === 'plan-workspace-configure') return workspaces.configure(raw)
    if (method === 'plan-workspace-review') return workspaces.review(raw)
    if (method === 'delete-task' || method === 'delete-plan') return deleteRecords(engine, method, raw, new Set(executor.active.keys()), jobTickets)
    if (method === 'human-control') return workflow.control(raw)
    if (method === 'task-materials-list') return materials.list(raw)
    if (method === 'task-materials-preview') return materials.preview(raw)
    if (method === 'task-materials-attach') return materials.attach(raw)
    if (method === 'runtime-status') { z.object({}).strict().parse(raw); return runtime.status() }
    if (method === 'runtime-verify-preview') return verification.preview(raw)
    if (method === 'runtime-verify') return verification.start(raw)
    if (method === 'runtime-verification-get') return verification.get(raw)
    if (method === 'runtime-verification-cancel') return verification.cancel(raw)
    if (method === 'runtime-reconcile') { requireCondition(!verification.active, 'RECONCILIATION_REQUIRED', 'Cancel and finish verification cleanup before reconciling runtime', 409); return runtime.reconcile(raw) }
    if (method === 'runtime-enable-preview' || method === 'runtime-disable-preview') return runtime.preview(method === 'runtime-enable-preview' ? 'enable' : 'disable', raw)
    if (method === 'runtime-enable') return runtime.enable(raw)
    if (method === 'runtime-disable') {
      const result = runtime.disable(raw)
      for (const id of result.affected) {
        const ticket = engine.require(id)
        const key = `runtime-stop:${result.operationId}:${id}`
        if (store.observed(key)) continue
        if (!ticket.mandate.humanHold && latestAssignment(ticket)?.id === result.assignments[id]) engine.call('task_stop', { ticketId: id, expectedRevision: ticket.revision, requestId: key, reason: 'Runtime stop requested by operator' })
        store.observe(key)
      }
      return result
    }
    if (method === 'runtime-clear-reviews') { z.object({}).strict().parse(raw); runtime.clearReviews(); materials.clear(); return { cleared: true } }
    if (method === 'runtime-answer') {
      const params = z.object({ id: z.string().uuid(), requestId: z.string().min(8).max(150), expectedRevision: z.number().int().positive(), repositoryId: z.string().min(1).max(1024), confirmation: z.string().uuid(), answers: answersSchema }).strict().parse(raw)
      const approval = store.approval(params.id)
      requireCondition(params.repositoryId === store.repository()!.id && params.confirmation === params.id && approval?.revision === params.expectedRevision, 'REVISION_CONFLICT', 'Input request changed; review the exact current question', 409)
      requireCondition(executor.answerRuntime, 'RUNTIME_UNSUPPORTED', 'Executor does not support user input')
      requireCondition(!store.observed(`runtime-answer:${params.requestId}`), 'INVALID_STATE', 'This answer request was already delivered or is uncertain', 409)
      store.observe(`runtime-answer:${params.requestId}`)
      await executor.answerRuntime(params.id, params.answers)
      return { answered: true }
    }
    if (method === 'worker-check' || method === 'runtime-check') {
      z.object({}).strict().parse(raw)
      const result = await runtime.check()
      const value = { ...result, diagnosticOnly: true, modelTurnTested: false }
      store.set('workerInspection', value)
      return value
    }
    if (method === 'approvals') { z.object({}).strict().parse(raw); return store.approvals().filter(entry => entry.status === 'pending').map(entry => ({ ...entry, targetTitle: entry.kind === 'plan' ? store.entity<{ title: string }>('plan', entry.ticketId)?.title : store.ticket(entry.ticketId)?.title })) }
    if (method === 'decide') {
      const params = z.object({ id: z.string(), accept: z.boolean(), expectedFingerprint: z.string().min(1).max(128).optional() }).strict().parse(raw)
      const approval = store.approval(params.id)
      if (approval?.kind === 'runtime') { await executor.decideRuntime(params.id, params.accept); return store.approval(params.id) }
      if (approval?.kind === 'publish' && params.accept) {
        requireCondition(config.gitlabEnabled, 'RUNTIME_UNAVAILABLE', 'Enable GitLab explicitly after isolated repository acceptance; no network write was attempted')
        requireCondition(params.expectedFingerprint, 'APPROVAL_REQUIRED', 'Confirm the fingerprint of the displayed publication preview')
        await delivery.approve(params.id, params.expectedFingerprint)
        return store.approval(params.id)
      }
      return workflow.decide(params.id, params.accept, params.expectedFingerprint)
    }
    if (method === 'publish-preview') {
      const params = z.object({ id: z.string(), authorName: z.string(), authorEmail: z.string() }).strict().parse(raw)
      return delivery.preview(params.id, params.authorName, params.authorEmail)
    }
    if (method === 'observe' || method === 'reconcile-publish') {
      const params = z.object({ ticketId: z.string() }).strict().parse(raw)
      requireCondition(config.gitlabEnabled, 'RUNTIME_UNAVAILABLE', 'GitLab integration is not enabled')
      if (method === 'observe') await delivery.observe(params.ticketId)
      else await delivery.reconcile(params.ticketId)
      return engine.view(engine.require(params.ticketId))
    }
    if (method === 'pause') { const params = z.object({ paused: z.boolean() }).strict().parse(raw); store.set('paused', params.paused); store.audit('', 'scheduler.paused', params); return params }
    if (method === 'inspect') { const params = z.object({ ticketId: z.string() }).strict().parse(raw); return inspectWorkspace(engine.require(params.ticketId)) }
    if (method === 'complete') { const params = z.object({ ticketId: z.string() }).strict().parse(raw); engine.complete(params.ticketId); return engine.view(engine.require(params.ticketId)) }
    if (method === 'accept-result') {
      const params = z.object({ ticketId: z.string(), expectedRevision: z.number().int().positive(), kind: z.enum(['artifact', 'code']), content: z.string().trim().min(1).max(30_000) }).strict().parse(raw)
      const ticket = engine.require(params.ticketId)
      const sha = params.kind === 'code' ? await verifyAcceptedCode(store.repository()!, ticket) : undefined
      return store.atomic(() => {
        const result = engine.coordination.acceptResult(params.ticketId, params.expectedRevision, params.kind, params.content, sha)
        if (ticket.planId) {
          const plan = engine.coordination.require<Plan>('plan', ticket.planId)
          if (plan.workflow && engine.coordination.canComplete(plan)) engine.coordination.complete(plan.id, plan.revision)
        }
        return result
      })
    }
    if (method === 'complete-plan') {
      const params = z.object({ planId: z.string(), expectedRevision: z.number().int().positive() }).strict().parse(raw)
      engine.coordination.complete(params.planId, params.expectedRevision)
      return engine.call('plan_get', { planId: params.planId })
    }
    if (method === 'reconcile') {
      const params = z.object({ ticketId: z.string(), note: z.string(), disposition: z.enum(['settled', 'pending']) }).strict().parse(raw)
      requireCondition(!executor.active.has(params.ticketId), 'INVALID_STATE', 'Execution is still active')
      engine.reconcile(params.ticketId, params.note, params.disposition)
      return engine.view(engine.require(params.ticketId))
    }
    if (method === 'backup') {
      z.object({}).strict().parse(raw)
      await mkdir(join(state, 'backups'), { mode: 0o700, recursive: true })
      const path = join(state, 'backups', `tasks-${Date.now()}-${randomUUID()}.sqlite`)
      await backup(store.db, path)
      await chmod(path, 0o600)
      return { path }
    }
    if (method === 'shutdown') { z.object({}).strict().parse(raw); setTimeout(() => { void close() }, 100); return { stopping: true } }
    throw new DomainError('FORBIDDEN', 'Unknown administrative operation')
  }
  const server = createServer(async (request, response) => {
    const operationId = randomUUID()
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    try {
      requireCondition(!closing, 'RUNTIME_UNAVAILABLE', 'Service is shutting down')
      requireCondition(lock.owned(), 'RUNTIME_UNAVAILABLE', 'Service no longer owns the state-directory lock')
      requireCondition(request.method === 'POST' && request.url === '/rpc' && !request.headers.origin, 'FORBIDDEN', 'Only local authenticated RPC is supported')
      const authorization = request.headers.authorization ?? ''
      const isAdmin = equal(authorization, admin)
      requireCondition(isAdmin || equal(authorization, bridge), 'UNAUTHENTICATED', 'Invalid local credential')
      const payload = rpcSchema.parse(await body(request))
      let data: unknown
      if (payload.method === 'plan_workspace_preview') data = await workspaces.preview(payload.params)
      else if (payload.method === 'task_workspace_prepare') data = await workspaces.prepare(payload.params)
      else if (Object.hasOwn(tools, payload.method)) {
        if (payload.method === 'plan_create') {
          const params = tools.plan_create.parse(payload.params)
          if (params.workspace && !store.receipt(engine.operatorId, 'plan_create', params.requestId, params)) await workspaces.validateInput(params.workspace)
        }
        data = engine.call(payload.method as keyof typeof tools, payload.params)
        if (payload.method === 'health') {
          const status = runtime.status()
          const inspectedVersion = status.inspection?.executable.version ?? runtimeVersion
          runtimeVersion = inspectedVersion
          data = { ...(data as object), runtimeReadiness: status.runtimeReadiness, runtime: status, workerInspection: store.get('workerInspection') }
          const approvals = store.approvals().filter(entry => entry.status === 'pending')
          const pending = store.effects('pending')
          data = { ...(data as object), repository: store.repository(), activeWorkers: executor.active.size, supportedCodex: SUPPORTED_CODEX, runtimeVersion, compatible: runtimeVersion === SUPPORTED_CODEX, accountAvailable: status.inspection?.auth.status === 'configured', usage: null, lockOwned: lock.owned(), executionEnabled: status.canDispatch, uncertainEffects: store.effects('uncertain').length, oldestQueuedAt: pending.length ? new Date(Math.min(...pending.map(entry => entry.dueAt))).toISOString() : null, oldestApprovalAt: approvals.map(entry => entry.createdAt).sort()[0] ?? null, lastRecovery: store.get('lastRecovery'), gitlab: { enabled: config.gitlabEnabled, observations: store.tickets().filter(ticket => ticket.mergeRequest).map(ticket => ({ ticketId: ticket.id, observation: store.get(`gitlab:${ticket.id}`) ?? null })) } }
        }
      } else {
        requireCondition(isAdmin, 'FORBIDDEN', 'This operation requires the trusted administrative channel')
        data = await callAdmin(payload.method, payload.params)
      }
      response.end(JSON.stringify({ ok: true, data, operationId }))
    } catch (error) {
      const known = error instanceof DomainError
      response.statusCode = known ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500
      response.end(JSON.stringify({ ok: false, error: { code: known ? error.code : response.statusCode === 400 ? 'INVALID_REQUEST' : 'RUNTIME_UNAVAILABLE', message: known ? error.message : response.statusCode === 400 ? 'Request does not match the operation schema' : 'Local operation failed; inspect prerequisites without blindly replaying it' }, operationId }))
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await rm(join(state, 'service.sock'), { force: true })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(state, 'service.sock'), resolve) })
    await chmod(join(state, 'service.sock'), 0o600)
  } catch (error) { store.close(); await lock.release(); throw error }
  const timer = setInterval(tick, 100)
  const refresh = () => {
    if (closing) return
    const job = runtime.check().then(() => undefined, () => undefined).finally(() => jobs.delete(job))
    jobs.add(job)
  }
  const inspectionTimer = setInterval(refresh, config.runtime.inspectionTtlSeconds * 1000)
  refresh()
  const close = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    clearInterval(inspectionTimer)
    await verification.close()
    await executor.shutdown()
    await Promise.allSettled([...jobs])
    await executor.shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    await rm(join(state, 'service.sock'), { force: true })
    if (lock.owned()) await lock.release()
  }
  return { close, store, engine, executor, server, runtime }
}
