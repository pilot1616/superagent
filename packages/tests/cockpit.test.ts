import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Engine } from '../core/src/engine.js'
import { graphLayout } from '../core/src/graph-layout.js'
import { latestAssignment, type Plan, type Ticket } from '../core/src/model.js'
import { Store } from '../storage/src/store.js'
import { runtimeReadiness } from '../executor-codex/src/acceptance.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

function fixture(blocker?: () => string | undefined) {
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo' })
  const engine = new Engine(store, 'human', blocker)
  const create = (title = 'Task') => (engine.call('task_create', { repositoryId: 'repo', title, request: `Scope ${title}`, requestId: randomUUID() }) as { ticket: Ticket }).ticket
  const versioned = (id: string) => ({ ticketId: id, expectedRevision: engine.require(id).revision, requestId: randomUUID() })
  const start = (id: string) => { engine.call('task_start', versioned(id)); engine.approve(store.approvals(id).find(entry => entry.status === 'pending')!.id, true) }
  const claim = (id: string) => {
    const effect = store.effects('pending').find(entry => entry.kind === 'launch' && entry.ticketId === id)!
    const ticket = engine.claim(effect)!
    assert.ok(ticket)
    store.saveEffect({ ...store.effects().find(entry => entry.key === effect.key)!, state: 'done' })
    engine.updateExecution(id, latestAssignment(ticket)!.id, current => { for (const entry of current.inputs) if (entry.state === 'pending') entry.state = 'accepted' }, 'fixture.inputs')
    return latestAssignment(ticket)!.id
  }
  const adjust = (id: string, extra = {}) => engine.call('task_adjust', { ...versioned(id), title: 'Revised task', scope: 'New bounded scope', reason: 'Requirement changed', priority: 3, resources: ['test:resource'], ...extra })
  const authorize = (plan: Plan) => {
    engine.call('plan_start', { planId: plan.id, expectedRevision: store.entity<Plan>('plan', plan.id)!.revision, requestId: randomUUID() })
    const approval = store.approvals(plan.id).find(entry => entry.status === 'pending')!
    engine.approve(approval.id, true, String(approval.details.fingerprint))
  }
  return { store, engine, create, versioned, start, claim, adjust, authorize }
}

test('closed runtime gate keeps approved effects pending and exposes actionable readiness', () => {
  const context = fixture(() => 'Real isolation acceptance is missing')
  try {
    const ticket = context.create(); context.start(ticket.id)
    const effect = context.store.effects('pending')[0]!
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(context.engine.claim(effect), undefined)
    const current = context.engine.require(ticket.id)
    assert.equal(current.mandate.executionGranted, true)
    assert.equal(current.failure, undefined)
    assert.equal(latestAssignment(current)!.state, 'pending')
    assert.equal(context.store.effects('pending')[0]!.attempts, 0)
    assert.equal(context.engine.view(current).scheduling.state, 'waiting_runtime')
    assert.equal(runtimeReadiness(true).enabled, false)
    assert.equal(runtimeReadiness(true).checks.filter(check => !check.passed).length, 13)
    assert.equal(runtimeReadiness(false).checks.find(check => check.key === 'version')!.passed, false)
    context.engine.call('task_stop', { ...context.versioned(ticket.id), reason: 'Stop even while gate is closed' })
    assert.equal(context.engine.require(ticket.id).ended, 'stopped')
  } finally { context.store.close() }
})

test('task filters search and counts cover all matching records rather than one page', () => {
  const context = fixture()
  try {
    for (let index = 0; index < 23; index++) context.create(`Work ${index}`)
    const stopped = context.create('History only')
    context.engine.call('task_stop', { ...context.versioned(stopped.id), reason: 'Archive' })
    const page = context.engine.call('task_list', { view: 'active', limit: 10 }) as any
    assert.equal(page.items.length, 10); assert.equal(page.total, 23); assert.equal(page.counts.all, 24); assert.equal(page.counts.finished, 1); assert.equal(page.nextCursor, 10)
    assert.equal((context.engine.call('task_list', { view: 'finished' }) as any).items[0].id, stopped.id)
    assert.equal((context.engine.call('task_list', { query: 'WORK 2' }) as any).total, 4)
    assert.equal((context.engine.call('task_list', { view: 'attention', cursor: 20, limit: 10 }) as any).items.length, 3)
    assert.throws(() => context.engine.call('task_list', { view: 'unknown' }))
  } finally { context.store.close() }
})

test('merged ready work remains in active and attention views until explicit result acceptance', () => {
  const context = fixture()
  try {
    const ticket = context.create('Merged work'); context.start(ticket.id)
    const assignment = context.claim(ticket.id)
    context.engine.report(ticket.id, assignment, { state: 'ready', summary: 'Ready for human acceptance', checks: [] })
    const current = context.engine.require(ticket.id)
    current.branch = 'task/merged'
    context.store.save(current)
    context.engine.syncMergeRequest(ticket.id, { iid: 1, url: 'https://gitlab.example/group/project/-/merge_requests/1', headSha: 'a'.repeat(40), branch: current.branch, state: 'merged', mergedSha: 'b'.repeat(40) })
    assert.equal((context.engine.call('task_list', { view: 'active' }) as any).items[0].awaitingAcceptance, true)
    assert.equal((context.engine.call('task_list', { view: 'attention' }) as any).total, 1)
    assert.equal((context.engine.call('task_list', { view: 'finished' }) as any).total, 0)
    context.engine.coordination.acceptResult(ticket.id, context.engine.require(ticket.id).revision, 'code', 'Verified exact merge commit', 'b'.repeat(40))
    assert.equal((context.engine.call('task_list', { view: 'active' }) as any).total, 0)
    assert.equal((context.engine.call('task_list', { view: 'attention' }) as any).total, 0)
    assert.equal((context.engine.call('task_list', { view: 'finished' }) as any).total, 1)
  } finally { context.store.close() }
})

test('progress is deduplicated, paged and survives a queued follow-up and scope adjustment', () => {
  const context = fixture()
  try {
    const ticket = context.create(); context.start(ticket.id)
    const assignment = context.claim(ticket.id)
    for (let index = 0; index < 24; index++) assert.equal(context.engine.progress(ticket.id, assignment, `item-${index}`, `Progress ${index}`), true)
    assert.equal(context.engine.progress(ticket.id, assignment, 'item-0', 'Duplicate'), false)
    context.engine.call('task_message', { ...context.versioned(ticket.id), text: 'Continue after this turn' })
    assert.equal(context.engine.report(ticket.id, assignment, { state: 'ready', summary: 'First turn conclusion', checks: ['Unit checks passed'] }), true)
    assert.equal(context.engine.require(ticket.id).report, undefined)
    assert.equal(context.engine.require(ticket.id).assignments.length, 2)
    const page = context.engine.call('task_get', { ticketId: ticket.id }) as any
    assert.equal(page.checkpointTotal, 25); assert.equal(page.checkpoints.length, 20); assert.equal(page.nextCheckpointCursor, 20)
    assert.equal(page.checkpoints[0].summary, 'First turn conclusion')
    assert.equal((context.engine.call('task_get', { ticketId: ticket.id, checkpointCursor: 20 }) as any).checkpoints.length, 5)
    context.adjust(ticket.id)
    assert.equal(context.engine.checkpoints(ticket.id).length, 25)
    assert.equal((context.engine.call('task_get', { ticketId: ticket.id }) as any).checkpoints[0].historical, true)
    assert.equal((context.engine.call('task_list', { query: 'Revised task' }) as any).items[0].summary, '历史结论：First turn conclusion')
    assert.equal(context.engine.progress(ticket.id, assignment, 'late', 'Late stale information'), false)
    assert.equal(context.engine.require(ticket.id).result, undefined)
  } finally { context.store.close() }
})

test('scope adjustment stops active work, revokes authorization and requires fresh human approval', () => {
  const context = fixture()
  try {
    const ticket = context.create(); context.start(ticket.id)
    const assignment = context.claim(ticket.id)
    const original = context.versioned(ticket.id)
    const request = { ...original, title: 'Revised', scope: 'Do only the revised work', reason: 'Changed requirements', priority: 2, resources: [] }
    context.engine.call('task_adjust', request)
    const current = context.engine.require(ticket.id)
    assert.equal(current.stopping, true); assert.equal(current.mandate.humanHold, true); assert.equal(current.mandate.executionGranted, false); assert.equal(current.restartThread, true)
    assert.equal(current.scope, request.scope)
    assert.equal(context.engine.report(ticket.id, assignment, { state: 'ready', summary: 'Late report', checks: [] }), false)
    assert.throws(() => context.adjust(ticket.id), /cleanup/)
    assert.deepEqual(context.engine.call('task_adjust', request), context.engine.call('task_adjust', request))
    context.engine.stopped(ticket.id)
    assert.throws(() => context.engine.call('task_adjust', { ...request, requestId: randomUUID() }), /revision/)
    context.engine.call('task_resume', context.versioned(ticket.id))
    assert.equal(context.store.effects('pending').filter(effect => effect.kind === 'launch').length, 0)
    const approval = context.store.approvals(ticket.id).find(entry => entry.status === 'pending')!
    context.engine.approve(approval.id, true)
    assert.equal(context.engine.require(ticket.id).mandate.humanHold, false)
    assert.equal(context.store.effects('pending').filter(effect => effect.kind === 'launch').length, 1)
    assert.equal(context.store.events(ticket.id).some(event => event.event === 'task.scope_adjusted' && (event.detail as any).previousScope === ticket.scope), true)
  } finally { context.store.close() }
})

test('plan member adjustment invalidates the whole grant and old reports but preserves independent holds', () => {
  const context = fixture()
  try {
    const created = context.engine.call('plan_create', { repositoryId: 'repo', title: 'Related work', tasks: ['a', 'b', 'integration'].map(key => ({ key, title: key, request: key })), dependencies: [{ before: 'a', after: 'integration', condition: 'artifact' }, { before: 'b', after: 'integration', condition: 'artifact' }], integrationKey: 'integration', maxAttempts: 3, expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID() }) as { plan: Plan; mapping: Record<string, string> }
    context.authorize(created.plan)
    const first = created.mapping.a!, held = created.mapping.b!
    const assignment = context.claim(first)
    context.engine.report(first, assignment, { state: 'ready', summary: 'Old local report', checks: [] })
    const heldAssignment = context.claim(held)
    context.engine.report(held, heldAssignment, { state: 'ready', summary: 'Other old report', checks: [] })
    context.engine.call('task_stop', { ...context.versioned(held), reason: 'Independent hold' })
    const before = context.store.entity<Plan>('plan', created.plan.id)!
    assert.throws(() => context.adjust(first), /plan revision/)
    context.adjust(first, { expectedPlanRevision: before.revision })
    const plan = context.store.entity<Plan>('plan', before.id)!
    assert.equal(plan.held, true); assert.equal(plan.grant, undefined); assert.equal(plan.version, before.version + 1)
    assert.equal(plan.maxAttempts, 3)
    assert.equal(context.engine.require(first).report, undefined)
    assert.equal(context.engine.checkpoints(first)[0]!.summary, 'Old local report')
    assert.equal(plan.heldTicketIds.includes(held), false)
    context.authorize(plan)
    assert.equal(context.engine.require(held).mandate.humanHold, true)
    assert.equal(context.engine.require(first).mandate.humanHold, false)
    assert.equal(context.engine.require(first).mandate.executionGranted, true)
    assert.equal(latestAssignment(context.engine.require(first))!.generation, 2)
    assert.equal((context.engine.call('task_get', { ticketId: held }) as any).checkpoints[0].historical, true)
    const restarted = context.claim(first)
    context.engine.progress(first, restarted, 'new-progress', 'Current plan progress')
    const detail = context.engine.call('task_get', { ticketId: first }) as any
    assert.equal(detail.checkpoints[0].historical, true)
    context.engine.bind(first, restarted, { threadId: 'new-scope-thread', version: 'test', profileHash: 'test' })
    assert.equal((context.engine.call('task_get', { ticketId: first }) as any).checkpoints[0].historical, false)
    assert.equal((context.engine.call('task_get', { ticketId: first }) as any).checkpoints[1].historical, true)
  } finally { context.store.close() }
})

test('scope adjustment preserves accepted producers and still permits whole-plan completion', () => {
  const context = fixture()
  try {
    const created = context.engine.call('plan_create', { repositoryId: 'repo', title: 'Adjust after acceptance', tasks: [{ key: 'producer', title: 'Producer', request: 'Stable result' }, { key: 'integration', title: 'Integration', request: 'Original integration scope' }], dependencies: [{ before: 'producer', after: 'integration', condition: 'artifact' }], integrationKey: 'integration', maxAttempts: 3, expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID() }) as { plan: Plan; mapping: Record<string, string> }
    context.authorize(created.plan)
    const producer = created.mapping.producer!, integration = created.mapping.integration!
    const producerAssignment = context.claim(producer)
    context.engine.report(producer, producerAssignment, { state: 'ready', summary: 'Stable accepted output', checks: [] })
    const accepted = context.engine.coordination.acceptResult(producer, context.engine.require(producer).revision, 'artifact', 'Accepted producer evidence')
    context.adjust(integration, { expectedPlanRevision: context.store.entity<Plan>('plan', created.plan.id)!.revision })
    context.authorize(context.store.entity<Plan>('plan', created.plan.id)!)
    const integrationAssignment = context.claim(integration)
    context.engine.report(integration, integrationAssignment, { state: 'ready', summary: 'Revised integration complete', checks: [] })
    context.engine.coordination.acceptResult(integration, context.engine.require(integration).revision, 'artifact', 'Accepted revised integration evidence')
    context.engine.coordination.complete(created.plan.id, context.store.entity<Plan>('plan', created.plan.id)!.revision)
    assert.equal(context.store.entity<Plan>('plan', created.plan.id)!.completed, true)
    assert.deepEqual(context.engine.require(producer).result, accepted)
    assert.equal(context.engine.require(producer).assignments.length, 1)
  } finally { context.store.close() }
})

test('scope adjustment retains the running assignment resource reservation until cleanup settles', () => {
  for (const legacy of [false, true]) {
    const context = fixture()
    try {
      const running = context.create('Running owner')
      running.resources = ['resource:old']
      context.store.save(running)
      context.start(running.id); context.claim(running.id)
      assert.deepEqual(latestAssignment(context.engine.require(running.id))!.resources, ['resource:old'])
      if (legacy) {
        const current = context.engine.require(running.id)
        delete latestAssignment(current)!.resources
        context.store.save(current)
      }
      const competitor = context.create('Old resource contender')
      competitor.resources = ['resource:old']
      context.store.save(competitor)
      context.start(competitor.id)
      const effect = context.store.effects('pending').find(entry => entry.kind === 'launch' && entry.ticketId === competitor.id)!
      context.adjust(running.id, { resources: ['resource:new'] })
      assert.deepEqual(context.engine.require(running.id).resources, ['resource:new'])
      assert.deepEqual(latestAssignment(context.engine.require(running.id))!.resources, ['resource:old'])
      assert.equal(context.engine.decision(context.engine.require(competitor.id)).state, 'waiting_resources')
      assert.equal(context.engine.claim(effect), undefined)
      context.engine.recover()
      assert.equal(context.engine.decision(context.engine.require(competitor.id)).state, 'waiting_resources')
      context.engine.reconcile(running.id, 'Verified original Worker and its process group have exited', 'settled')
      assert.ok(context.engine.claim(effect))
    } finally { context.store.close() }
  }
})

test('accepted results reject scope edits without altering immutable evidence', () => {
  const context = fixture()
  try {
    const ticket = context.create(); context.start(ticket.id)
    const assignment = context.claim(ticket.id)
    context.engine.report(ticket.id, assignment, { state: 'ready', summary: 'Local result', checks: [] })
    const result = context.engine.coordination.acceptResult(ticket.id, context.engine.require(ticket.id).revision, 'artifact', 'Human accepted evidence')
    assert.throws(() => context.adjust(ticket.id), /immutable/)
    assert.deepEqual(context.engine.require(ticket.id).result, result)
  } finally { context.store.close() }
})

test('failed execution conclusions remain visible after retry and preserve their original scope', () => {
  const context = fixture()
  try {
    const ticket = context.create(); context.start(ticket.id)
    const assignment = context.claim(ticket.id)
    context.engine.fail(ticket.id, assignment, 'The relevant check failed')
    context.engine.call('task_retry', context.versioned(ticket.id))
    const approval = context.store.approvals(ticket.id).find(entry => entry.status === 'pending')!
    context.engine.approve(approval.id, true)
    assert.equal(context.engine.require(ticket.id).failure, undefined)
    const checkpoint = context.engine.checkpoints(ticket.id)[0]!
    assert.equal(checkpoint.kind, 'system'); assert.equal(checkpoint.scope, ticket.scope)
    assert.equal(checkpoint.summary, 'The relevant check failed')
  } finally { context.store.close() }
})

test('DAG layout places independent roots side by side vertically and all prerequisites before dependents', () => {
  const dependencies = [{ before: 'a', after: 'c', condition: 'artifact' as const }, { before: 'b', after: 'c', condition: 'code' as const }, { before: 'c', after: 'd', condition: 'artifact' as const }]
  const graph = graphLayout(['d', 'a', 'b', 'c'], dependencies)
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  assert.equal(nodes.get('a')!.level, 0); assert.equal(nodes.get('b')!.level, 0)
  assert.notEqual(nodes.get('a')!.y, nodes.get('b')!.y)
  for (const edge of dependencies) assert.ok(nodes.get(edge.before)!.x < nodes.get(edge.after)!.x)
  assert.equal(graphLayout([], []).nodes.length, 0)
  assert.throws(() => graphLayout(['a'], [{ before: 'foreign', after: 'a', condition: 'code' }]), /missing dependency/)
  assert.throws(() => graphLayout(['a', 'b'], [{ before: 'a', after: 'b', condition: 'code' }, { before: 'b', after: 'a', condition: 'code' }]), /cyclic/)
})

test('checkpoint evidence survives closing and reopening the project database', async () => {
  const root = await mkdtemp('/tmp/sa-checkpoints-')
  let store = new Store(join(root, 'tasks.sqlite'))
  try {
    store.set('repository', { id: 'repo' })
    const engine = new Engine(store, 'human')
    const ticket = (engine.call('task_create', { repositoryId: 'repo', title: 'Durable conclusion', request: 'Original scope', requestId: randomUUID() }) as { ticket: Ticket }).ticket
    engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    engine.approve(store.approvals(ticket.id)[0]!.id, true)
    const current = engine.claim(store.effects('pending')[0]!)!
    const assignment = latestAssignment(current)!
    engine.progress(ticket.id, assignment.id, 'progress-durable', 'A durable intermediate finding')
    store.close(); store = new Store(join(root, 'tasks.sqlite'))
    const recovered = new Engine(store, 'human')
    recovered.recover()
    assert.equal(recovered.checkpoints(ticket.id)[0]!.summary, 'A durable intermediate finding')
    assert.equal(recovered.checkpoints(ticket.id)[0]!.scope, 'Original scope')
    assert.equal(recovered.require(ticket.id).result, undefined)
    assert.ok(recovered.require(ticket.id).reconciliation)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})
