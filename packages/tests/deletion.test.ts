import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Engine } from '../core/src/engine.js'
import { deleteRecords } from '../core/src/deletion.js'
import { type Plan, type TaskEvent, type Thread, type Ticket, type WorkerAgent } from '../core/src/model.js'
import { candidates } from '../core/src/scheduler.js'
import { Store } from '../storage/src/store.js'

function fixture(filename = ':memory:') {
  const store = new Store(filename)
  store.set('repository', { id: 'repo' })
  const engine = new Engine(store, 'operator')
  const create = (title = 'Delete fixture') => (engine.call('task_create', { repositoryId: 'repo', title, request: 'A bounded task', requestId: randomUUID() }) as { ticket: Ticket }).ticket
  const taskParams = (ticket: Ticket) => ({ ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID() })
  const plan = () => (engine.call('plan_create', { repositoryId: 'repo', title: 'Delete group', tasks: [{ key: 'source', title: 'Source', request: 'Produce contract' }, { key: 'integration', title: 'Integration', request: 'Integrate result' }], dependencies: [{ before: 'source', after: 'integration', condition: 'artifact' }], integrationKey: 'integration', expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID() }) as { plan: Plan }).plan
  const planParams = (value: Plan) => ({ planId: value.id, expectedRevision: store.entity<Plan>('plan', value.id)!.revision, tasks: value.ticketIds.map(ticketId => ({ ticketId, expectedRevision: engine.require(ticketId).revision })), requestId: randomUUID() })
  return { store, engine, create, taskParams, plan, planParams }
}

test('deletion persists across reopen, preserves files and audit, and rejects stale resurrection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sa-delete-'))
  const filename = join(root, 'tasks.sqlite')
  let store: Store | undefined
  try {
    const context = fixture(filename)
    store = context.store
    const ticket = context.create()
    ticket.workspace = root
    store.save(ticket)
    await writeFile(join(root, 'user-file.txt'), 'retain this file')
    const params = context.taskParams(ticket)
    const receipt = deleteRecords(context.engine, 'delete-task', params)
    assert.deepEqual(deleteRecords(context.engine, 'delete-task', params), receipt)
    assert.equal(store.ticket(ticket.id), undefined)
    assert.equal(store.tickets().length, 0)
    assert.ok(store.events(ticket.id).some(entry => entry.event === 'task.deleted'))
    assert.equal(store.entity<{ ticket: Ticket }>('deleted_task', ticket.id)!.ticket.workspace, root)
    assert.throws(() => store!.save(ticket), /deleted/)
    assert.throws(() => deleteRecords(context.engine, 'delete-task', { ...params, expectedRevision: params.expectedRevision + 1 }), /request ID/)
    store.close()
    store = new Store(filename)
    const restarted = new Engine(store, 'operator')
    restarted.recover()
    assert.deepEqual(deleteRecords(restarted, 'delete-task', params), receipt)
    assert.equal(store.tickets().length, 0)
    assert.deepEqual(candidates(store, new Set(), new Set(), 2), [])
    assert.equal(await readFile(join(root, 'user-file.txt'), 'utf8'), 'retain this file')
  } finally { store?.close(); await rm(root, { recursive: true, force: true }) }
})

for (const ended of ['stopped', 'completed'] as const) test(`deletion accepts ${ended} task histories without discarding results`, () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const ticket = create()
    ticket.ended = ended
    ticket.assignments.push({ id: randomUUID(), generation: 1, state: 'ended' })
    ticket.report = { state: 'ready', summary: 'Preserved conclusion', checks: ['fixture'] }
    store.save(ticket)
    deleteRecords(engine, 'delete-task', taskParams(ticket))
    assert.equal(store.entity<{ ticket: Ticket }>('deleted_task', ticket.id)!.ticket.report!.summary, 'Preserved conclusion')
  } finally { store.close() }
})

for (const condition of ['pending', 'running', 'stopping', 'reconciliation', 'effect', 'agent', 'active', 'busy'] as const) test(`deletion rejects ${condition} without changing records`, () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const ticket = create()
    if (condition === 'pending' || condition === 'running') ticket.assignments.push({ id: randomUUID(), generation: 1, state: condition })
    if (condition === 'stopping') ticket.stopping = true
    if (condition === 'reconciliation') ticket.reconciliation = 'Inspect uncertain execution'
    if (condition === 'effect') store.saveEffect({ key: randomUUID(), ticketId: ticket.id, kind: 'publish', generation: 1, payload: {}, state: 'uncertain', attempts: 1, dueAt: Date.now() })
    if (condition === 'agent') store.saveEntity('worker_agent', 'child', { id: 'child', ticketId: ticket.id, cleanup: 'uncertain' } as WorkerAgent)
    store.save(ticket)
    assert.throws(() => deleteRecords(engine, 'delete-task', taskParams(ticket), new Set(condition === 'active' ? [ticket.id] : []), new Set(condition === 'busy' ? [ticket.id] : [])), /请先停止/)
    assert.deepEqual(store.ticket(ticket.id), ticket)
    assert.equal(store.entities('deleted_task').length, 0)
  } finally { store.close() }
})

test('deletion expires pending approval, fences late effects and rejects stale revisions', () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const ticket = create()
    const stale = taskParams(ticket)
    engine.call('task_start', { ...stale, requestId: randomUUID() })
    const approval = store.approvals(ticket.id)[0]!
    assert.throws(() => deleteRecords(engine, 'delete-task', stale), /已变化/)
    deleteRecords(engine, 'delete-task', taskParams(ticket))
    assert.equal(store.approval(approval.id)!.status, 'expired')
    assert.throws(() => store.saveApproval(approval), /deleted/)
    assert.throws(() => store.saveEffect({ key: randomUUID(), ticketId: ticket.id, kind: 'launch', generation: 1, payload: {}, state: 'pending', attempts: 0, dueAt: Date.now() }), /deleted/)
    assert.throws(() => engine.approve(approval.id, true))
  } finally { store.close() }
})

test('failed tasks can be deleted and late feedback cannot recreate tasks or subscriptions', () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const ticket = create()
    ticket.failure = 'Settled fixture failure'
    ticket.assignments.push({ id: randomUUID(), generation: 1, state: 'ended' })
    store.save(ticket)
    deleteRecords(engine, 'delete-task', taskParams(ticket))
    assert.throws(() => engine.receiveFeedback(ticket.id, 'late-note', 'Feedback after deletion'), /not found/)
    assert.equal(store.entities('thread').length, 0)
    assert.equal(store.entities('event').length, 0)
    assert.equal(store.observed('late-note'), false)
    assert.equal(store.ticket(ticket.id), undefined)
  } finally { store.close() }
})

test('deleting one event owner preserves remaining owners and shared context', () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const removed = create('Remove owner')
    const retained = create('Keep owner')
    const thread = (engine.call('thread_create', { title: 'Shared context', requestId: randomUUID() }) as { thread: Thread }).thread
    for (const ticket of [removed, retained]) engine.call('thread_subscribe', { threadId: thread.id, expectedRevision: store.entity<Thread>('thread', thread.id)!.revision, ticketId: ticket.id, mode: 'owning', requestId: randomUUID() })
    const { event } = engine.call('event_record', { threadIds: [thread.id], text: 'Shared follow-up', requestId: randomUUID() }) as { event: TaskEvent }
    deleteRecords(engine, 'delete-task', taskParams(removed))
    assert.deepEqual(store.entity<TaskEvent>('event', event.id)!.owners, [retained.id])
    assert.deepEqual(store.entity<Thread>('thread', thread.id)!.subscriptions.map(entry => entry.ticketId), [retained.id])
    const context = engine.call('route_context', { eventId: event.id }) as any
    assert.equal(context.requiresExplicitDecision, false)
    assert.deepEqual(context.relatedTasks.map((entry: any) => entry.ticket.id), [retained.id])
  } finally { store.close() }
})

test('deletion removes subscriptions and releases event ownership without losing delivery history', () => {
  const { store, engine, create, taskParams } = fixture()
  try {
    const ticket = create()
    const thread = (engine.call('thread_create', { title: 'Context', requestId: randomUUID() }) as { thread: Thread }).thread
    engine.call('thread_subscribe', { threadId: thread.id, expectedRevision: thread.revision, ticketId: ticket.id, mode: 'owning', requestId: randomUUID() })
    const { event } = engine.call('event_record', { threadIds: [thread.id], text: 'Follow-up', requestId: randomUUID() }) as { event: TaskEvent }
    deleteRecords(engine, 'delete-task', taskParams(ticket))
    const saved = store.entity<TaskEvent>('event', event.id)!
    assert.deepEqual(saved.owners, [])
    assert.ok(saved.returned.includes(ticket.id))
    assert.ok(saved.delivered.includes(ticket.id))
    assert.deepEqual(store.entity<Thread>('thread', thread.id)!.subscriptions, [])
    assert.equal((engine.call('route_context', { eventId: event.id }) as any).requiresExplicitDecision, true)
    assert.doesNotThrow(() => engine.call('event_record', { threadIds: [thread.id], text: 'New follow-up', requestId: randomUUID() }))
  } finally { store.close() }
})

test('plan deletion requires the entire reviewed graph and atomically preserves its archive', () => {
  const { store, engine, create, taskParams, plan, planParams } = fixture()
  try {
    const independent = create('Keep this task')
    const group = plan()
    const params = planParams(group)
    assert.throws(() => deleteRecords(engine, 'delete-task', taskParams(engine.require(group.ticketIds[0]!))), /不能单独删除/)
    assert.throws(() => deleteRecords(engine, 'delete-plan', { ...params, tasks: params.tasks.slice(1) }), /全部成员/)
    assert.throws(() => deleteRecords(engine, 'delete-plan', { ...params, tasks: [params.tasks[0], params.tasks[0]] }), /全部成员/)
    assert.throws(() => deleteRecords(engine, 'delete-plan', { ...params, expectedRevision: params.expectedRevision + 1 }), /计划已变化/)
    const changed = engine.require(group.ticketIds[1]!)
    engine.call('task_message', { ticketId: changed.id, expectedRevision: changed.revision, text: 'New constraint', requestId: randomUUID() })
    assert.throws(() => deleteRecords(engine, 'delete-plan', params), /已变化/)
    assert.equal(store.tickets().length, 3)
    assert.equal(store.entities('deleted_task').length, 0)
    const current = planParams(group)
    const receipt = deleteRecords(engine, 'delete-plan', current)
    assert.deepEqual(deleteRecords(engine, 'delete-plan', current), receipt)
    assert.deepEqual(store.tickets().map(ticket => ticket.id), [independent.id])
    assert.equal(store.entities('plan').length, 0)
    assert.deepEqual(store.entity<{ plan: Plan }>('deleted_plan', group.id)!.plan.dependencies, group.dependencies)
    assert.equal(store.entities('deleted_task').length, 2)
    assert.throws(() => store.saveEntity('plan', group.id, group), /deleted/)
  } finally { store.close() }
})

test('one busy plan member prevents all deletion, and storage failures roll back the whole transaction', () => {
  const { store, engine, plan, planParams } = fixture()
  try {
    const group = plan()
    const params = planParams(group)
    assert.throws(() => deleteRecords(engine, 'delete-plan', params, new Set([group.ticketIds[1]!])) , /请先停止/)
    assert.equal(store.tickets().length, 2)
    const remove = store.removeTicket.bind(store)
    store.removeTicket = id => { remove(id); if (id === group.ticketIds[1]) throw new Error('fixture storage fault') }
    assert.throws(() => deleteRecords(engine, 'delete-plan', params), /fixture storage fault/)
    assert.equal(store.tickets().length, 2)
    assert.equal(store.entities('deleted_task').length, 0)
    assert.equal(store.entities('deleted_plan').length, 0)
    assert.equal(store.events(group.ticketIds[0]!).some(entry => entry.event === 'task.deleted'), false)
    store.removeTicket = remove
    assert.equal(deleteRecords(engine, 'delete-plan', params).deletedTaskIds.length, 2)
  } finally { store.close() }
})

test('completed plans retain accepted results and checkpoints when deleted', () => {
  const { store, engine, plan, planParams } = fixture()
  try {
    const group = plan()
    group.completed = true
    store.saveEntity('plan', group.id, group)
    for (const id of group.ticketIds) {
      const ticket = engine.require(id)
      ticket.ended = 'completed'
      ticket.result = { id: randomUUID(), ticketId: id, kind: 'artifact', content: 'Accepted result', hash: 'fixture', acceptedAt: new Date().toISOString(), operatorId: 'operator' }
      store.save(ticket)
      store.saveEntity('checkpoint', id, { id, ticketId: id, summary: 'Preserved progress' })
    }
    deleteRecords(engine, 'delete-plan', planParams(group))
    assert.equal(store.entities('checkpoint').length, 2)
    assert.equal(store.entity<{ ticket: Ticket }>('deleted_task', group.integrationId)!.ticket.result!.content, 'Accepted result')
    engine.recover()
    assert.deepEqual(store.tickets(), [])
    assert.deepEqual(store.entities('plan'), [])
  } finally { store.close() }
})
