import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, realpath, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { initialize } from '../service/src/config.js'
import { createProfile, loadProfile } from '../executor-codex/src/profile.js'
import { startService } from '../service/src/daemon.js'
import { invoke } from '../service/src/ipc.js'
import { git, prepareWorkspace } from '../service/src/workspace.js'
import { Delivery } from '../integrations-gitlab/src/delivery.js'
import type { Executor } from '../core/src/ports.js'
import type { Ticket } from '../core/src/model.js'
import { tools } from '../core/src/engine.js'

test('real daemon keeps approved tasks pending before environment checks and human enablement', async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-gate-'))
  const state = join(root, 's'), repo = join(root, 'r')
  let service: Awaited<ReturnType<typeof startService>> | undefined
  try {
    await git(root, ['init', repo]); await writeFile(join(repo, 'README'), 'gate fixture')
    await git(repo, ['add', 'README']); await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
    await initialize(state, repo, join(root, 'w'), 'test-model')
    service = await startService(state)
    const ticket = (service.engine.call('task_create', { repositoryId: service.store.repository()!.id, title: 'Wait safely', request: 'Bounded task', requestId: randomUUID() }) as { ticket: Ticket }).ticket
    service.engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    service.engine.approve(service.store.approvals(ticket.id)[0]!.id, true)
    await delay(350)
    const detail = (await invoke(state, 'bridge', 'task_get', { ticketId: ticket.id })).data as any
    assert.equal(detail.scheduling.state, 'waiting_runtime')
    assert.equal(detail.ticket.failure, undefined)
    assert.equal(detail.ticket.assignments[0].state, 'pending')
    assert.equal(service.store.effects('pending')[0]!.attempts, 0)
    assert.equal(((await invoke(state, 'bridge', 'health')).data as any).runtimeReadiness.checks.filter((entry: any) => !entry.passed).length >= 5, true)
    service.engine.call('task_stop', { ticketId: ticket.id, expectedRevision: detail.ticket.revision, requestId: randomUUID(), reason: 'Human stopped queued work' })
    assert.equal(service.engine.require(ticket.id).ended, 'stopped')
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
})

test('real Codex Worker with repository-linked skills reaches only a loopback fixture provider without verification evidence', { timeout: 25000 }, async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-dispatch-'))
  const state = join(root, 's'), repository = join(root, 'r')
  const requests: { url?: string; body: string }[] = []
  const provider = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString() })
    request.on('end', () => {
      requests.push({ url: request.url, body })
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Local fixture intentionally refuses model inference', type: 'invalid_request_error' } }))
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address() as { port: number }
  let service: Awaited<ReturnType<typeof startService>> | undefined
  try {
    await git(root, ['init', repository]); await writeFile(join(repository, 'README'), 'Local dispatch fixture\n')
    await mkdir(join(repository, '.agents'))
    await mkdir(join(repository, 'skills/fixture'), { recursive: true })
    await writeFile(join(repository, 'skills/fixture/SKILL.md'), '---\nname: fixture\ndescription: Synthetic local fixture only\n---\nRepository skill data, not execution authority.\n')
    await symlink('../skills', join(repository, '.agents/skills'))
    await git(repository, ['add', 'README', '.agents', 'skills']); await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
    await initialize(state, repository, join(root, 'w'), 'not-a-real-model')
    await createProfile(state, 'not-a-real-model', { id: 'fixture', authMode: 'none', baseUrl: `http://127.0.0.1:${address.port}/v1` })
    service = await startService(state)
    await service.runtime.check()
    assert.equal(service.runtime.status().phase, 'ready')
    const repositoryId = service.store.repository()!.id
    const { ticket } = service.engine.call('task_create', { repositoryId, title: 'Local dispatch smoke', request: 'Only a synthetic local fixture; no external inference', requestId: randomUUID() }) as { ticket: Ticket }
    service.engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    service.engine.approve(service.store.approvals(ticket.id)[0]!.id, true)
    const preview = service.runtime.preview('enable', { repositoryId, expectedRevision: service.runtime.state().revision })
    service.runtime.enable({ requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId, confirmation: repositoryId, reviewId: preview.reviewId, mode: 'restricted_local', expectedFingerprint: preview.expectedFingerprint, reason: 'Disposable local provider test only' })
    const deadline = Date.now() + 12000
    while (!requests.some(request => request.url === '/v1/responses') && Date.now() < deadline && !service.engine.require(ticket.id).failure && service.engine.require(ticket.id).assignments.at(-1)?.launchPhase !== 'ended') await delay(25)
    const current = service.engine.require(ticket.id)
    const request = requests.find(entry => entry.url === '/v1/responses')
    assert.ok(request, JSON.stringify({ failure: current.failure, phase: current.assignments.at(-1)?.launchPhase, runtime: service.runtime.status().reasonCodes, events: service.store.events(repositoryId).slice(-4), taskEvents: service.store.events(ticket.id).slice(-5) }))
    assert.equal(JSON.parse(request.body).model, 'not-a-real-model')
    assert.ok(current.workspace?.startsWith(join(root, 'w')))
    assert.ok(current.binding?.threadId)
    assert.equal(await git(repository, ['status', '--porcelain=v1']), '')
    assert.equal((await loadProfile(state)).model, 'not-a-real-model')
    assert.equal(service.store.entities('runtime_verification').length, 0)
    assert.equal(service.runtime.status().verificationPassed, false)
  } finally { await service?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('a workspace stays bound to its task when project execution configuration blocks preflight', { timeout: 15000 }, async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-preflight-'))
  const state = join(root, 's'), repository = join(root, 'r')
  let service: Awaited<ReturnType<typeof startService>> | undefined
  try {
    await git(root, ['init', repository])
    await mkdir(join(repository, '.codex'))
    await writeFile(join(repository, '.codex/config.toml'), 'model = "not-execution-authority"\n')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
    await initialize(state, repository, join(root, 'w'), 'not-a-real-model')
    await createProfile(state, 'not-a-real-model', { id: 'fixture', authMode: 'none', baseUrl: 'http://127.0.0.1:9/v1' })
    service = await startService(state)
    await service.runtime.check()
    const repositoryId = service.store.repository()!.id
    const { ticket } = service.engine.call('task_create', { repositoryId, title: 'Preflight rejection', request: 'Never launch a model turn', requestId: randomUUID() }) as { ticket: Ticket }
    service.engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    service.engine.approve(service.store.approvals(ticket.id)[0]!.id, true)
    const preview = service.runtime.preview('enable', { repositoryId, expectedRevision: service.runtime.state().revision })
    service.runtime.enable({ requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId, confirmation: repositoryId, reviewId: preview.reviewId, mode: 'restricted_local', expectedFingerprint: preview.expectedFingerprint, reason: 'Disposable preflight regression only' })
    await waitFor(() => service!.engine.view(service!.engine.require(ticket.id)).scheduling.state === 'waiting_workspace')
    const current = service.engine.require(ticket.id)
    assert.match(service.engine.view(current).scheduling.reasons.join(' '), /checkout contains \.codex/)
    assert.equal(current.failure, undefined)
    assert.equal(current.assignments.at(-1)!.startedAt, undefined)
    assert.equal(service.store.effects().find(effect => effect.ticketId === ticket.id)!.attempts, 0)
    assert.equal(current.workspace, join(root, 'w', ticket.id))
    assert.equal(current.branch, `superagent/${ticket.id}`)
    assert.equal(current.baseSha, service.store.repository()!.baseSha)
    assert.equal(current.binding, undefined)
    assert.equal(service.executor.active.size, 0)
    assert.equal(service.store.get(`process:${ticket.id}`), undefined)
    assert.deepEqual(await prepareWorkspace(service.store.repository()!, current), { workspace: current.workspace, branch: current.branch, baseSha: current.baseSha })
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
})

test('authenticated service, MCP transport, concurrency, backup and restart preserve manual holds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-')))
  const state = join(root, 's')
  const repository = join(root, 'r')
  await git(root, ['init', repository])
  await writeFile(join(repository, 'README'), 'fixture\n')
  await git(repository, ['add', 'README'])
  await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
  await initialize(state, repository, join(root, 'w'), 'test-model')
  let launched = 0
  let stopped = 0
  const active = new Map<string, Ticket>()
  const executor: Executor = { active, async launch(ticket) { launched++; active.set(ticket.id, ticket) }, async stop(id) { stopped++; active.delete(id); service.engine.stopped(id) }, async decideRuntime() { throw new Error('No live approvals') }, async shutdown() { active.clear() } }
  let service = await startService(state, () => executor)
  const client = new Client({ name: 'integration-test', version: '1' })
  try {
    await assert.rejects(() => startService(state, () => executor), /lock exists/)
    const denied = await invoke(state, 'bridge', 'decide', { id: 'fabricated', accept: true })
    assert.equal(denied.error?.code, 'FORBIDDEN')
    const unauthorized = await readFile(join(state, 'bridge.token'), 'utf8')
    await writeFile(join(state, 'bridge.token'), 'invalid')
    assert.equal((await invoke(state, 'bridge', 'health')).error?.code, 'UNAUTHENTICATED')
    await writeFile(join(state, 'bridge.token'), unauthorized)
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/service/src/cli.js'), 'mcp', 'bridge', '--state', state], stderr: 'pipe' })
    await client.connect(transport)
    const list = await client.listTools()
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), Object.keys(tools).map(name => `superagent_${name}`).sort())
    assert.ok(!list.tools.some(tool => /approve|shell|sql/.test(tool.name)))
    const payload = { repositoryId: service.store.repository()!.id, title: 'Test task', request: 'Change fixture safely', requestId: randomUUID() }
    const created = await client.callTool({ name: 'superagent_task_create', arguments: payload })
    assert.equal(created.isError, false)
    const ticket = (created.structuredContent as any).data.ticket as Ticket
    assert.equal(launched, 0)
    const copies = await Promise.all(Array.from({ length: 8 }, () => invoke(state, 'bridge', 'task_create', payload)))
    assert.ok(copies.every(copy => (copy.data as any).ticket.id === ticket.id))
    assert.equal(service.store.tickets().length, 1)
    await invoke(state, 'bridge', 'task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    assert.equal(launched, 0)
    await invoke(state, 'admin', 'pause', { paused: true })
    await invoke(state, 'admin', 'decide', { id: service.store.approvals()[0]!.id, accept: true })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(launched, 0)
    await invoke(state, 'admin', 'pause', { paused: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(launched, 1)
    await invoke(state, 'bridge', 'task_stop', { ticketId: ticket.id, expectedRevision: service.engine.require(ticket.id).revision, requestId: randomUUID(), reason: 'Human stop' })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(stopped, 1)
    assert.equal(service.engine.require(ticket.id).ended, 'stopped')
    assert.equal((await invoke(state, 'admin', 'backup')).ok, true)
    await client.close()
    await service.close()
    service = await startService(state, () => executor)
    assert.equal(service.engine.require(ticket.id).mandate.humanHold, true)
    assert.equal(service.engine.require(ticket.id).ended, 'stopped')
  } finally { await client.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

async function isolatedService(gitlabEnabled = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-service-review-')))
  const state = join(root, 's')
  const repository = join(root, 'repo')
  await git(root, ['init', '-b', 'main', repository])
  await writeFile(join(repository, 'README'), 'base\n')
  await git(repository, ['add', 'README'])
  await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'])
  await git(repository, ['remote', 'add', 'origin', 'https://gitlab.com/example/fixture.git'])
  await initialize(state, repository, join(root, 'worktrees'), 'test-model', 'main')
  const config = JSON.parse(await readFile(join(state, 'service.json'), 'utf8'))
  await writeFile(join(state, 'service.json'), JSON.stringify({ ...config, concurrency: 2, gitlabEnabled }))
  const active = new Map<string, Ticket>()
  let launches = 0
  const service = await startService(state, (_store, engine) => ({
    active,
    async launch(ticket) { launches++; active.set(ticket.id, ticket) },
    async stop(id) { active.delete(id); engine.stopped(id) },
    async decideRuntime() { throw new Error('No real Worker in test') },
    async shutdown() { active.clear() },
  }))
  const { ticket } = service.engine.call('task_create', { repositoryId: service.store.repository()!.id, title: 'Service review', request: 'Test fixture', requestId: randomUUID() }) as { ticket: Ticket }
  service.engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
  service.engine.approve(service.store.approvals()[0]!.id, true)
  return { ...service, ticket, state, active, launches: () => launches, cleanup: async () => { await service.close(); await rm(root, { recursive: true, force: true }) } }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await delay(25)
  assert.ok(predicate(), 'Service condition was not reached before the deadline')
}

test('daemon rejects missing preview fingerprint and recovers known preflight failure without external writes', async () => {
  const context = await isolatedService(true)
  try {
    const { engine, store, ticket, state } = context
    const effect = store.effects('pending')[0]!
    const running = engine.claim(effect)!
    const workspace = await prepareWorkspace(store.repository()!, running)
    engine.updateExecution(ticket.id, running.assignments[0]!.id, current => { Object.assign(current, workspace); current.inputs[0]!.state = 'accepted' }, 'fixture.workspace')
    engine.report(ticket.id, running.assignments[0]!.id, { state: 'ready', summary: 'Ready', checks: [] })
    store.saveEffect({ ...store.effects('running')[0]!, state: 'done' })
    const forbidden = async (): Promise<never> => { throw new Error('External I/O is forbidden in this test') }
    const delivery = new Delivery(store, engine, state, { find: forbidden, read: forbidden, create: forbidden, feedback: forbidden }, forbidden)
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, headSha: await git(workspace.workspace, ['rev-parse', 'HEAD']), requestId: randomUUID() })
    const approval = store.approvals().find(entry => entry.kind === 'publish')!
    const preview = await delivery.preview(approval.id, 'Test', 'test@example.invalid')
    assert.equal((await invoke(state, 'admin', 'decide', { id: approval.id, accept: true })).error?.code, 'APPROVAL_REQUIRED')
    await delivery.approve(approval.id, preview.fingerprint)
    writeFileSync(join(workspace.workspace, 'README'), 'changed before scheduled publication\n')
    await waitFor(() => store.events(ticket.id).some(event => event.event === 'publish.preflight_rejected'))
    assert.equal(store.effects('uncertain').length, 0)
    assert.equal(engine.require(ticket.id).reconciliation, undefined)
    assert.equal(store.approval(approval.id)!.status, 'expired')
    assert.equal(await git(workspace.workspace, ['rev-parse', 'HEAD']), preview.headSha)
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, headSha: preview.headSha, requestId: randomUUID() })
    assert.equal(store.approvals().filter(entry => entry.status === 'pending').length, 1)
  } finally { await context.cleanup() }
})

test('concurrency above one never dispatches a replacement while that ticket still has an active Worker', async () => {
  const context = await isolatedService()
  try {
    const { engine, ticket, active } = context
    await waitFor(() => context.launches() === 1)
    const assignmentId = engine.require(ticket.id).assignments[0]!.id
    engine.updateExecution(ticket.id, assignmentId, current => { current.inputs[0]!.state = 'accepted' }, 'fixture.accepted')
    engine.call('task_message', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID(), text: 'Follow-up work' })
    engine.report(ticket.id, assignmentId, { state: 'ready', summary: 'Turn ended before process cleanup', checks: [] })
    await delay(250)
    assert.equal(context.launches(), 1)
    assert.equal(engine.require(ticket.id).assignments.at(-1)!.state, 'pending')
    active.delete(ticket.id)
    await waitFor(() => context.launches() === 2)
    assert.equal(engine.require(ticket.id).assignments.at(-1)!.state, 'running')
  } finally { await context.cleanup() }
})
