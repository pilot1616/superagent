import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { backup } from 'node:sqlite'
import { z } from 'zod'
import { Engine, tools } from '../../core/src/engine.js'
import { DomainError, latestAssignment, requireCondition, type Effect } from '../../core/src/model.js'
import type { Executor } from '../../core/src/ports.js'
import { Store } from '../../storage/src/store.js'
import { CodexExecutor } from '../../executor-codex/src/executor.js'
import { SUPPORTED_CODEX, codexVersion } from '../../executor-codex/src/probe.js'
import { acceptance, executionVerified } from '../../executor-codex/src/acceptance.js'
import { acquireLock, readConfig } from './config.js'
import { inspectWorkspace } from './workspace.js'
import { GitHubHttp } from '../../integrations-github/src/api.js'
import { Delivery } from '../../integrations-github/src/delivery.js'
import { pushCommit } from '../../integrations-github/src/workspace.js'

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
  const engine = new Engine(store, config.operatorId)
  let runtimeVersion: string | null = null
  try { runtimeVersion = codexVersion() } catch {}
  const executor = factory?.(store, engine) ?? new CodexExecutor(store, engine, state)
  const github = new GitHubHttp(state)
  const delivery = new Delivery(store, engine, state, github, async (ticket, preview, sha) => pushCommit(ticket, preview, sha, await github.token()))
  engine.recover()
  let closing = false
  const jobs = new Set<Promise<void>>()
  let observedAt = 0
  let observing = false
  const poll = async () => {
    observing = true
    try {
      for (const ticket of store.tickets()) {
        if (closing) break
        if (!ticket.pull || ticket.pull.state !== 'open' || executor.active.has(ticket.id) || store.effects('running').some(effect => effect.ticketId === ticket.id)) continue
        const prior = store.get<{ nextAttempt?: number; failures?: number }>(`github:${ticket.id}`)
        if ((prior?.nextAttempt ?? 0) > Date.now() || (prior?.failures ?? 0) >= 6) continue
        try { await delivery.observe(ticket.id) }
        catch {
          const failures = (prior?.failures ?? 0) + 1
          store.set(`github:${ticket.id}`, { ...prior, failures, nextAttempt: Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 5_000), state: 'read-failed' })
        }
      }
    } finally { observing = false }
  }
  const finish = (effect: Effect, status: Effect['state']) => store.saveEffect({ ...(store.effects().find(entry => entry.key === effect.key) ?? effect), state: status })
  const dispatch = async (effect: Effect) => {
    const ticket = engine.claim(effect)
    if (!ticket) return
    try {
      if (effect.kind === 'launch') await executor.launch(ticket)
      else if (effect.kind === 'stop') {
        requireCondition(!store.effects('running').some(entry => entry.ticketId === ticket.id && entry.kind === 'publish'), 'RECONCILIATION_REQUIRED', 'Publication is in flight; cancellation needs external reconciliation')
        await executor.stop(ticket.id)
      } else {
        requireCondition(config.githubEnabled, 'RUNTIME_UNAVAILABLE', 'GitHub delivery is disabled in service configuration')
        await delivery.publish(effect)
      }
      finish(effect, 'done')
    } catch (error) {
      const uncertain = effect.kind !== 'launch' || Boolean(engine.require(ticket.id).reconciliation)
      if (effect.kind === 'launch') engine.fail(ticket.id, latestAssignment(ticket)!.id, error instanceof DomainError ? error.message : 'Execution failed; inspect the local runtime and recover before retrying', uncertain)
      else store.atomic(() => { const current = engine.require(ticket.id); current.reconciliation = 'External or stop operation is uncertain; inspect before retrying'; current.revision++; store.save(current); store.audit(ticket.id, 'effect.uncertain', { kind: effect.kind }) })
      finish(effect, uncertain ? 'uncertain' : 'done')
    }
  }
  const tick = () => {
    if (closing) return
    if (!lock.owned()) { void close(); return }
    engine.expireApprovals()
    for (const effect of store.effects('pending')) {
      if (effect.dueAt > Date.now()) continue
      if (effect.kind === 'launch' && (store.get('paused') || executor.active.size + jobs.size >= config.concurrency)) continue
      const job = dispatch(effect).finally(() => jobs.delete(job))
      jobs.add(job)
    }
    if (config.githubEnabled && !observing && Date.now() - observedAt >= 60_000) {
      observedAt = Date.now()
      const job = poll().finally(() => jobs.delete(job))
      jobs.add(job)
    }
  }
  const callAdmin = async (method: string, raw: unknown): Promise<unknown> => {
    if (method === 'approvals') { z.object({}).strict().parse(raw); return store.approvals().filter(entry => entry.status === 'pending') }
    if (method === 'decide') {
      const params = z.object({ id: z.string(), accept: z.boolean() }).strict().parse(raw)
      const approval = store.approval(params.id)
      if (approval?.kind === 'runtime') { await executor.decideRuntime(params.id, params.accept); return store.approval(params.id) }
      if (approval?.kind === 'publish' && params.accept) {
        requireCondition(config.githubEnabled, 'RUNTIME_UNAVAILABLE', 'Enable GitHub explicitly after isolated repository acceptance; no network write was attempted')
        await delivery.approve(params.id)
        return store.approval(params.id)
      }
      return engine.approve(params.id, params.accept)
    }
    if (method === 'publish-preview') {
      const params = z.object({ id: z.string(), authorName: z.string(), authorEmail: z.string() }).strict().parse(raw)
      return delivery.preview(params.id, params.authorName, params.authorEmail)
    }
    if (method === 'observe' || method === 'reconcile-publish') {
      const params = z.object({ ticketId: z.string() }).strict().parse(raw)
      requireCondition(config.githubEnabled, 'RUNTIME_UNAVAILABLE', 'GitHub integration is not enabled')
      if (method === 'observe') await delivery.observe(params.ticketId)
      else await delivery.reconcile(params.ticketId)
      return engine.view(engine.require(params.ticketId))
    }
    if (method === 'pause') { const params = z.object({ paused: z.boolean() }).strict().parse(raw); store.set('paused', params.paused); store.audit('', 'scheduler.paused', params); return params }
    if (method === 'inspect') { const params = z.object({ ticketId: z.string() }).strict().parse(raw); return inspectWorkspace(engine.require(params.ticketId)) }
    if (method === 'complete') { const params = z.object({ ticketId: z.string() }).strict().parse(raw); engine.complete(params.ticketId); return engine.view(engine.require(params.ticketId)) }
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
      if (Object.hasOwn(tools, payload.method)) {
        data = engine.call(payload.method as keyof typeof tools, payload.params)
        if (payload.method === 'health') {
          const approvals = store.approvals().filter(entry => entry.status === 'pending')
          const pending = store.effects('pending')
          data = { ...(data as object), repository: store.repository(), activeWorkers: executor.active.size, supportedCodex: SUPPORTED_CODEX, runtimeVersion, compatible: runtimeVersion === SUPPORTED_CODEX, accountAvailable: null, usage: null, lockOwned: lock.owned(), executionEnabled: executionVerified(), acceptance, uncertainEffects: store.effects('uncertain').length, oldestQueuedAt: pending.length ? new Date(Math.min(...pending.map(entry => entry.dueAt))).toISOString() : null, oldestApprovalAt: approvals.map(entry => entry.createdAt).sort()[0] ?? null, lastRecovery: store.get('lastRecovery'), github: { enabled: config.githubEnabled, observations: store.tickets().filter(ticket => ticket.pull).map(ticket => ({ ticketId: ticket.id, observation: store.get(`github:${ticket.id}`) ?? null })) } }
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
  const close = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    await executor.shutdown()
    await Promise.allSettled([...jobs])
    await executor.shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    await rm(join(state, 'service.sock'), { force: true })
    if (lock.owned()) await lock.release()
  }
  return { close, store, engine, executor, server }
}
