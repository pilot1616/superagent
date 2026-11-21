import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { invoke } from '../service/src/ipc.js'
import { git, prepareWorkspace, registerRepository, verifyAcceptedCode } from '../service/src/workspace.js'
import { latestAssignment, type AcceptedResult, type Plan, type Ticket } from '../core/src/model.js'
import type { Engine } from '../core/src/engine.js'
import { startPanel } from '../service/src/panel.js'

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await delay(30) }
  assert.ok(check(), 'Timed out waiting for local service')
}

test('real daemon automatically hands off parallel roots, guards final acceptance, and persists the goal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-graph-'))), state = join(root, 's'), repo = join(root, 'r')
  await git(root, ['init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'fixture\n')
  await git(repo, ['add', 'README'])
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
  await initialize(state, repo, join(root, 'w'), 'test-model', 'main')
  const config = JSON.parse(await readFile(join(state, 'service.json'), 'utf8'))
  await writeFile(join(state, 'service.json'), JSON.stringify({ ...config, concurrency: 2 }))
  const active = new Map<string, Ticket>(), launches: string[] = []
  let engine: Engine
  const factory = (_store: unknown, instance: Engine) => {
    engine = instance
    return { active, async launch(ticket: Ticket) { launches.push(ticket.id); active.set(ticket.id, ticket) }, async stop(id: string) { active.delete(id); engine.stopped(id) }, async decideRuntime() {}, async shutdown() { active.clear() } }
  }
  let service = await startService(state, factory)
  const finish = async (id: string) => {
    const assignment = latestAssignment(engine.require(id))!
    engine.updateExecution(id, assignment.id, ticket => ticket.inputs.forEach(entry => { entry.state = 'accepted' }), 'test.accepted')
    active.delete(id)
    engine.report(id, assignment.id, { state: 'ready', summary: 'Independent fixture completed', checks: ['fixture check'] })
    await eventually(() => !service.store.effects().some(effect => effect.ticketId === id && effect.state !== 'done'))
  }
  try {
    const request = { repositoryId: service.store.repository()!.id, title: 'Parallel delivery', tasks: ['backend', 'frontend', 'integration'].map(key => ({ key, title: key, request: `Implement ${key}` })), dependencies: ['backend', 'frontend'].map(before => ({ before, after: 'integration', condition: 'artifact' })), integrationKey: 'integration', maxAttempts: 3, expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID() }
    const response = await invoke(state, 'bridge', 'plan_create', request)
    assert.equal(response.ok, true)
    const { plan, mapping } = response.data as { plan: Plan; mapping: Record<string, string> }
    const panel = await startPanel(state)
    try {
      const login = await fetch(`${panel.origin}/login`, { method: 'POST', headers: { origin: panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: panel.loginSecret }) })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const graph = await fetch(`${panel.origin}/api/plans/${plan.id}`, { headers: { cookie } })
      const graphBody = await graph.json() as any
      assert.equal(graphBody.data.tasks.length, 3)
      assert.equal(graphBody.data.plan.dependencies.length, 2)
      const denied = await fetch(`${panel.origin}/api/plans/${plan.id}`, { method: 'POST', headers: { cookie } })
      assert.equal(denied.status, 403)
    } finally { await panel.close() }
    assert.equal((await invoke(state, 'bridge', 'plan_create', request)).ok, true)
    assert.equal(service.store.tickets().length, 3)
    await invoke(state, 'bridge', 'plan_start', { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = service.store.approvals(plan.id)[0]!
    assert.equal((await invoke(state, 'bridge', 'decide', { id: approval.id, accept: true, expectedFingerprint: approval.details.fingerprint })).error?.code, 'FORBIDDEN')
    assert.equal((await invoke(state, 'admin', 'decide', { id: approval.id, accept: true })).ok, false)
    assert.equal((await invoke(state, 'admin', 'decide', { id: approval.id, accept: true, expectedFingerprint: approval.details.fingerprint })).ok, true)
    await eventually(() => active.size === 2)
    assert.deepEqual(new Set(active.keys()), new Set([mapping.backend, mapping.frontend]))
    assert.equal((await invoke(state, 'admin', 'complete-plan', { planId: plan.id, expectedRevision: service.store.entity<Plan>('plan', plan.id)!.revision })).ok, false)
    for (const key of ['backend', 'frontend']) {
      const id = mapping[key]!
      await finish(id)
      const acceptance = { ticketId: id, expectedRevision: engine!.require(id).revision, kind: 'artifact', content: `Reviewed ${key}` }
      assert.equal((await invoke(state, 'bridge', 'accept-result', acceptance)).error?.code, 'FORBIDDEN')
      await eventually(() => engine!.require(id).result?.acceptedBy === 'coordinator')
    }
    await eventually(() => active.has(mapping.integration!))
    assert.equal(latestAssignment(engine!.require(mapping.integration!))!.inputs!.length, 2)
    await finish(mapping.integration!)
    assert.equal((await invoke(state, 'admin', 'accept-result', { ticketId: mapping.integration, expectedRevision: engine!.require(mapping.integration!).revision, kind: 'artifact', content: 'Integration checks reviewed' })).ok, true)
    assert.equal(service.store.entity<Plan>('plan', plan.id)!.completed, true)
    assert.equal(launches.length, 3)
    assert.ok(service.store.events(mapping.integration!).some(event => event.event === 'scheduler.decision'))
    await invoke(state, 'admin', 'backup')
    await service.close()
    service = await startService(state, factory)
    assert.equal((await invoke(state, 'bridge', 'plan_get', { planId: plan.id })).ok, true)
    assert.equal(service.store.entity<Plan>('plan', plan.id)!.completed, true)
    await delay(150)
    assert.equal(launches.length, 3)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

test('dependency worktrees pin a common base containing both upstream commits, never copy uncommitted work', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-base-'))), repo = join(root, 'r')
  try {
    await git(root, ['init', '-b', 'main', repo])
    await git(repo, ['config', 'user.name', 'Test']); await git(repo, ['config', 'user.email', 'test@invalid'])
    await writeFile(join(repo, 'README'), 'base\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base'])
    const registered = await registerRepository(repo, join(root, 'w'), 'main')
    await writeFile(join(repo, 'backend'), 'backend\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'merge backend'])
    const first = await git(repo, ['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'frontend'), 'frontend\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'merge frontend'])
    const second = await git(repo, ['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'local-only'), 'not committed\n')
    const result = (sha: string, ticketId: string): AcceptedResult => ({ id: randomUUID(), ticketId, kind: 'code', content: 'Merged and reviewed', sha, hash: sha, acceptedAt: new Date().toISOString(), operatorId: 'human' })
    const ticket = { id: randomUUID(), assignments: [{ id: randomUUID(), generation: 1, state: 'running', inputs: [result(first, 'backend'), result(second, 'frontend')] }] } as Ticket
    const prepared = await prepareWorkspace(registered, ticket)
    assert.equal(prepared.baseSha, second)
    assert.notEqual(prepared.baseSha, registered.baseSha)
    assert.equal(await readFile(join(prepared.workspace, 'backend'), 'utf8'), 'backend\n')
    assert.equal(await readFile(join(prepared.workspace, 'frontend'), 'utf8'), 'frontend\n')
    await assert.rejects(() => readFile(join(prepared.workspace, 'local-only')))
    const upstream = { mergeRequest: { state: 'merged', mergedSha: first } } as Ticket
    assert.equal(await verifyAcceptedCode(registered, upstream), first)
    await assert.rejects(() => verifyAcceptedCode(registered, { mergeRequest: { state: 'closed', mergedSha: first } } as Ticket))
    await git(repo, ['checkout', '-b', 'not-integrated', registered.baseSha])
    await writeFile(join(repo, 'unmerged'), 'unmerged\n'); await git(repo, ['add', 'unmerged']); await git(repo, ['commit', '-m', 'not merged'])
    const unmerged = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['checkout', 'main'])
    const blocked = { id: randomUUID(), assignments: [{ id: randomUUID(), generation: 1, state: 'running', inputs: [result(unmerged, 'unmerged')] }] } as Ticket
    await assert.rejects(() => prepareWorkspace(registered, blocked))
    assert.equal(await git(repo, ['branch', '--show-current']), 'main')
  } finally { await rm(root, { recursive: true, force: true }) }
})
