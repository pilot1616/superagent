import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { startPanel } from '../service/src/panel.js'
import { writePanelToken } from '../service/src/panel-token.js'
import { invoke } from '../service/src/ipc.js'
import { git } from '../service/src/workspace.js'
import type { Approval, Plan } from '../core/src/model.js'

async function fixture(synthetic = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-panel-')))
  const state = join(root, 's'), repo = join(root, 'r')
  await git(root, ['init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'fixture\n')
  await git(repo, ['add', 'README'])
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
  await initialize(state, repo, join(root, 'w'), 'test-model', 'main')
  const service = await startService(state, synthetic ? (_store, engine) => ({ active: new Map(), async launch() { throw new Error('Synthetic Worker must be driven explicitly by the test') }, async stop(ticketId) { engine.stopped(ticketId) }, async decideRuntime() { throw new Error('No synthetic runtime approval') }, async shutdown() {} }) : undefined)
  await invoke(state, 'admin', 'pause', { paused: true })
  const panel = await startPanel(state)
  const login = await fetch(`${panel.origin}/login`, { method: 'POST', headers: { origin: panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: panel.loginSecret }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const session = await (await fetch(`${panel.origin}/api/session`, { headers: { cookie } })).json() as any
  const headers = { cookie, origin: panel.origin, 'content-type': 'application/json', 'x-superagent-csrf': session.data.csrf }
  const post = (path: string, data: unknown, extra = {}) => fetch(`${panel.origin}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) })
  const plan = (service.engine.call('plan_create', { repositoryId: service.store.repository()!.id, title: 'Reviewed plan', tasks: [{ key: 'integration', title: 'Acceptance', request: 'Explicit bounded work' }], dependencies: [], integrationKey: 'integration', maxAttempts: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), requestId: randomUUID() }) as { plan: Plan }).plan
  return { state, service, panel, headers, post, plan, async close() { await panel.close(); await service.close(); await rm(root, { recursive: true, force: true }) } }
}

test('panel offers server-side compact task filters, pending notes and versioned scope adjustment', async () => {
  const context = await fixture()
  try {
    const create = (title: string) => (context.service.engine.call('task_create', { repositoryId: context.service.store.repository()!.id, title, request: `Scope ${title}`, requestId: randomUUID() }) as any).ticket
    for (let index = 0; index < 13; index++) create(`Compact ${index}`)
    const target = create('Editable task')
    const get = async (path: string) => (await (await fetch(`${context.panel.origin}${path}`, { headers: { cookie: context.headers.cookie } })).json() as any).data
    const page = await get('/api/tasks')
    assert.equal(page.items.length, 10); assert.equal(page.total, 15); assert.equal(page.nextCursor, 10)
    assert.equal((await get('/api/tasks?query=compact&limit=10&cursor=10')).items.length, 3)
    const message = { action: 'task_message', params: { ticketId: target.id, expectedRevision: target.revision, requestId: randomUUID(), text: 'Review this new constraint in the next turn' }, confirmation: target.id }
    assert.equal((await context.post('/api/control', message, { 'x-superagent-csrf': 'wrong' })).status, 403)
    assert.equal((await (await context.post('/api/control', message)).json() as any).ok, true)
    let detail = await get(`/api/tasks/${target.id}`)
    assert.equal(detail.ticket.inputs.at(-1).state, 'pending')
    const adjust = { action: 'task_adjust', params: { ticketId: target.id, expectedRevision: detail.ticket.revision, requestId: randomUUID(), title: 'Adjusted title', scope: 'New scope confirmed by the human', reason: 'Changed requirement', priority: 2, resources: [] }, confirmation: target.id }
    assert.equal((await (await context.post('/api/control', adjust)).json() as any).ok, true)
    detail = await get(`/api/tasks/${target.id}`)
    assert.equal(detail.ticket.title, 'Adjusted title'); assert.equal(detail.ticket.mandate.executionGranted, false)
    assert.equal(detail.ticket.inputs[0].superseded, true)
    assert.equal(detail.ticket.inputs.at(-1).state, 'pending')
    assert.equal((await get('/api/tasks?view=finished')).total, 1)
    assert.equal((await get('/api/tasks?view=active')).total, 14)
    assert.equal((await get(`/api/plans/${context.plan.id}`)).plan.dependencies.length, 0)
    assert.equal((await get('/api/health')).runtimeReadiness.enabled, false)
    assert.equal((await context.post('/api/worker-check', {}, { 'x-superagent-csrf': 'wrong' })).status, 403)
    assert.equal((await context.post('/api/worker-check', { bypass: true })).status, 400)
    assert.equal((await invoke(context.state, 'bridge', 'worker-check')).error?.code, 'FORBIDDEN')
    const rejected = await context.post('/api/control', { ...adjust, params: { ...adjust.params, requestId: randomUUID() } })
    assert.equal((await rejected.json() as any).error.code, 'REVISION_CONFLICT')
  } finally { await context.close() }
})

test('panel rejects missing authentication, CSRF, cross-origin, oversized and unknown controls', async () => {
  const context = await fixture()
  try {
    const { panel, post, headers } = context
    const input = { action: 'plan_start', params: { planId: context.plan.id, expectedRevision: 1, requestId: randomUUID() }, confirmation: context.plan.id }
    assert.equal((await fetch(`${panel.origin}/api/control`, { method: 'POST', headers: { origin: panel.origin, 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 401)
    assert.equal((await post('/api/control', input, { 'x-superagent-csrf': '' })).status, 403)
    assert.equal((await post('/api/control', input, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post('/api/control', { ...input, confirmation: 'wrong' })).status, 403)
    assert.equal((await post('/api/control', { ...input, action: 'shutdown' })).status, 400)
    assert.equal((await post('/api/decide', input)).status, 405)
    assert.equal((await post('/api/control', { padding: 'a'.repeat(70_000) })).status, 413)
    assert.equal((await fetch(`${panel.origin}/api/control`, { method: 'POST', headers, body: '{' })).status, 400)
    assert.equal((await fetch(`${panel.origin}/api/admin`, { headers: { cookie: headers.cookie } })).status, 404)
    assert.equal(context.service.store.approvals().length, 0)
  } finally { await context.close() }
})

test('panel plan approval requires full preview, exact confirmation and single-use review', async () => {
  const context = await fixture()
  try {
    const { post, plan, service, panel, headers } = context
    const start = await (await post('/api/control', { action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() }, confirmation: plan.id })).json() as any
    assert.equal(start.ok, true)
    const approval = service.store.approvals(plan.id)[0]!
    const list = await (await fetch(`${panel.origin}/api/approvals`, { headers: { cookie: headers.cookie } })).json() as any
    assert.equal(list.data[0].id, approval.id)
    assert.equal(list.data[0].targetTitle, plan.title)
    const preview = await (await post(`/api/approvals/${approval.id}/preview`, {})).json() as any
    assert.equal(preview.data.context.plan.id, plan.id)
    assert.equal(preview.data.approval.details.fingerprint, approval.details.fingerprint)
    const decision = { reviewId: preview.data.reviewId, accept: true, confirmation: approval.id }
    assert.equal((await post(`/api/approvals/${approval.id}/decide`, { ...decision, confirmation: 'wrong' })).status, 403)
    const accepted = await (await post(`/api/approvals/${approval.id}/decide`, decision)).json() as any
    assert.equal(accepted.ok, true)
    assert.equal(service.store.approval(approval.id)!.status, 'accepted')
    assert.equal((await post(`/api/approvals/${approval.id}/decide`, decision)).status, 409)
    assert.equal((await invoke(context.state, 'bridge', 'decide', { id: approval.id, accept: true })).error?.code, 'FORBIDDEN')
  } finally { await context.close() }
})

test('panel rejects changed previews and invalidates reviews and CSRF on login rotation', async () => {
  const context = await fixture()
  try {
    const { service, post, plan, panel } = context
    service.engine.call('plan_start', { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = service.store.approvals(plan.id)[0]!
    const preview = await (await post(`/api/approvals/${approval.id}/preview`, {})).json() as any
    service.store.saveApproval({ ...approval, details: { ...approval.details, modified: true } })
    assert.equal((await post(`/api/approvals/${approval.id}/decide`, { reviewId: preview.data.reviewId, accept: true, confirmation: approval.id })).status, 409)
    assert.equal(service.store.approval(approval.id)!.status, 'pending')
    const login = await fetch(`${panel.origin}/login`, { method: 'POST', headers: { origin: panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: panel.loginSecret }) })
    assert.equal(login.status, 200)
    assert.equal((await post('/api/control', {})).status, 401)
  } finally { await context.close() }
})

test('panel supports plan pause and stop without erasing independent holds or bypassing versions', async () => {
  const context = await fixture()
  try {
    const { service, post, plan } = context
    const send = (action: string, params = {}) => post('/api/control', { action, params: { planId: plan.id, expectedRevision: service.store.entity<Plan>('plan', plan.id)!.revision, requestId: randomUUID(), ...params }, confirmation: plan.id })
    assert.equal(((await (await send('plan_pause', { paused: true })).json()) as any).ok, true)
    assert.equal(service.store.entity<Plan>('plan', plan.id)!.paused, true)
    assert.equal(((await (await send('plan_stop', { reason: 'Human requested stop' })).json()) as any).ok, true)
    assert.equal(service.store.entity<Plan>('plan', plan.id)!.held, true)
    const stale = await (await post('/api/control', { action: 'plan_pause', params: { planId: plan.id, expectedRevision: 1, requestId: randomUUID(), paused: false }, confirmation: plan.id })).json() as any
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'REVISION_CONFLICT')
  } finally { await context.close() }
})

test('panel runtime accept remains forbidden and publishing requires a generated diff preview', async () => {
  const context = await fixture()
  try {
    const { service, post, plan } = context
    const ticketId = plan.ticketIds[0]!
    for (const kind of ['runtime', 'publish'] as const) {
      const approval: Approval = { id: randomUUID(), ticketId, revision: service.engine.require(ticketId).revision, kind, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), details: {} }
      service.store.saveApproval(approval)
      const response = await post(`/api/approvals/${approval.id}/preview`, {})
      if (kind === 'publish') { assert.equal(response.status, 409); continue }
      const preview = await response.json() as any
      assert.equal(preview.data.canAccept, false)
      assert.equal((await post(`/api/approvals/${approval.id}/decide`, { reviewId: preview.data.reviewId, accept: true, confirmation: approval.id })).status, 403)
    }
  } finally { await context.close() }
})

test('panel token is atomically saved privately, cannot overwrite arbitrary paths or follow symlinks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-token-')))
  try {
    const destination = join(root, 'panel-login.token'), other = join(root, 'other')
    await writeFile(other, 'preserved')
    await assert.rejects(writePanelToken(root, other, 'secret'), /STATE\/panel-login.token/)
    await symlink(other, destination)
    await writePanelToken(root, destination, 'first-token')
    assert.equal(await readFile(other, 'utf8'), 'preserved')
    assert.equal(await readFile(destination, 'utf8'), 'first-token')
    assert.equal((await stat(destination)).mode & 0o777, 0o600)
    await writePanelToken(root, destination, 'rotated-token')
    assert.equal(await readFile(destination, 'utf8'), 'rotated-token')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('panel accepts only settled ready results before whole-plan completion and keeps code checks', async () => {
  const context = await fixture(true)
  try {
    const { service, post, plan } = context
    service.engine.call('plan_start', { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = service.store.approvals(plan.id)[0]!
    service.engine.approve(approval.id, true, approval.details.fingerprint as string)
    const ticketId = plan.ticketIds[0]!
    const accept = (kind: string) => post('/api/control', { action: 'accept-result', params: { ticketId, expectedRevision: service.engine.require(ticketId).revision, kind, content: 'Human reviewed evidence' }, confirmation: ticketId })
    assert.equal(((await (await accept('artifact')).json()) as any).ok, false)
    service.store.set('paused', false)
    const effect = service.store.effects('pending').find(entry => entry.kind === 'launch')!
    const ticket = service.engine.claim(effect)!
    service.store.set('paused', true)
    assert.ok(ticket)
    const assignment = ticket.assignments.at(-1)!
    service.engine.updateExecution(ticketId, assignment.id, current => { current.inputs.forEach(input => { input.state = 'accepted' }) }, 'test.inputs_accepted')
    service.engine.report(ticketId, assignment.id, { state: 'ready', summary: 'Fixture output', checks: ['fixture'] })
    service.store.saveEffect({ ...effect, state: 'done' })
    assert.equal(((await (await accept('code')).json()) as any).ok, false)
    assert.equal(((await (await accept('artifact')).json()) as any).ok, true)
    assert.equal(((await (await accept('artifact')).json()) as any).ok, false)
    const complete = await (await post('/api/control', { action: 'complete-plan', params: { planId: plan.id, expectedRevision: service.store.entity<Plan>('plan', plan.id)!.revision }, confirmation: plan.id })).json() as any
    assert.equal(complete.ok, true)
    assert.equal(service.store.entity<Plan>('plan', plan.id)!.completed, true)
  } finally { await context.close() }
})

test('panel rejects expired approvals even when a review was previously issued', async () => {
  const context = await fixture()
  try {
    const { service, post, plan } = context
    service.engine.call('plan_start', { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = service.store.approvals(plan.id)[0]!
    const preview = await (await post(`/api/approvals/${approval.id}/preview`, {})).json() as any
    service.store.saveApproval({ ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() })
    assert.equal((await post(`/api/approvals/${approval.id}/decide`, { reviewId: preview.data.reviewId, accept: true, confirmation: approval.id })).status, 409)
    assert.notEqual(service.store.approval(approval.id)!.status, 'accepted')
  } finally { await context.close() }
})

test('T11/T12: panels on two ports keep independent cookies, CSRF and login rotations', async () => {
  const left = await fixture(), right = await fixture()
  try {
    assert.notEqual(left.headers.cookie.split('=')[0], right.headers.cookie.split('=')[0])
    const cookies = `${left.headers.cookie}; ${right.headers.cookie}`
    for (const context of [left, right]) assert.equal((await fetch(`${context.panel.origin}/api/session`, { headers: { cookie: cookies } })).status, 200)
    const rotated = await fetch(`${left.panel.origin}/login`, { method: 'POST', headers: { origin: left.panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: ` \n${left.panel.loginSecret}\t ` }) })
    assert.equal(rotated.status, 200)
    assert.equal((await fetch(`${left.panel.origin}/api/session`, { headers: { cookie: cookies } })).status, 401)
    assert.equal((await fetch(`${right.panel.origin}/api/session`, { headers: { cookie: cookies } })).status, 200)
    const cookie = rotated.headers.get('set-cookie')!.split(';')[0]!
    const csrf = ((await (await fetch(`${left.panel.origin}/api/session`, { headers: { cookie } })).json()) as any).data.csrf
    assert.notEqual(csrf, left.headers['x-superagent-csrf'])
    assert.equal((await fetch(`${left.panel.origin}/api/runtime/check`, { method: 'POST', headers: { ...left.headers, cookie }, body: '{}' })).status, 403)
    let status = 0
    for (let attempt = 0; attempt < 11; attempt++) status = (await fetch(`${left.panel.origin}/login`, { method: 'POST', headers: { origin: left.panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'incorrect-fixture-token' }) })).status
    assert.equal(status, 429)
  } finally { await left.close(); await right.close() }
})

test('T13: a second panel for the same state cannot overwrite the published instance or token', async () => {
  const context = await fixture()
  try {
    const before = await readFile(join(context.state, 'panel-login.token'), 'utf8')
    await assert.rejects(startPanel(context.state), /already owns a panel/)
    assert.equal(await readFile(join(context.state, 'panel-login.token'), 'utf8'), before)
    const record = JSON.parse(await readFile(join(context.state, 'panel-session.json'), 'utf8'))
    assert.equal(record.instanceId, context.panel.instanceId)
    assert.equal(record.origin, context.panel.origin)
    assert.equal(record.published, true)
    assert.equal(JSON.stringify(record).includes(before), false)
    assert.equal((await fetch(`${context.panel.origin}/api/session`, { headers: { cookie: context.headers.cookie } })).status, 200)
  } finally { await context.close() }
})

test('runtime administration is authenticated, CSRF-protected, strict and never exposed over bridge', async () => {
  const context = await fixture()
  try {
    for (const method of ['runtime-status', 'runtime-enable', 'runtime-verify', 'runtime-answer']) assert.equal((await invoke(context.state, 'bridge', method, {})).error?.code, 'FORBIDDEN')
    assert.equal((await fetch(`${context.panel.origin}/api/runtime`)).status, 401)
    assert.equal((await fetch(`${context.panel.origin}/api/runtime`, { headers: { cookie: context.headers.cookie } })).status, 200)
    assert.equal((await context.post('/api/runtime/enable', { verified: true, skipAcceptance: true }, { 'x-superagent-csrf': 'invalid' })).status, 403)
    const result = await (await context.post('/api/runtime/enable', { verified: true, skipAcceptance: true })).json() as any
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_REQUEST')
    assert.equal(context.service.runtime.status().canDispatch, false)
  } finally { await context.close() }
})
