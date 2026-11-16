import assert from 'node:assert/strict'
import test from 'node:test'
import { Engine } from '../core/src/engine.js'
import { stage, type Ticket } from '../core/src/model.js'
import { Store } from '../storage/src/store.js'

function fixture() {
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo' })
  return { store, engine: new Engine(store, 'test-operator') }
}
const creation = { repositoryId: 'repo', title: 'Fix bug', request: 'Fix the specified bug', requestId: 'request-0001' }
const ticketOf = (value: unknown) => (value as { ticket: Ticket }).ticket
test('manual creation is atomic and idempotent; conflicting reuse is rejected', () => {
  const { store, engine } = fixture()
  try {
    const first = ticketOf(engine.call('task_create', creation))
    assert.equal(ticketOf(engine.call('task_create', creation)).id, first.id)
    assert.equal(stage(first), 'draft')
    assert.throws(() => engine.call('task_create', { ...creation, title: 'Different' }), /different content/)
    assert.equal(store.tickets().length, 1)
    assert.equal(store.effects().length, 0)
  } finally { store.close() }
})
test('execution requires explicit approval; stopped tasks stay held across messages and restart', () => {
  const { store, engine } = fixture()
  try {
    const created = ticketOf(engine.call('task_create', creation))
    engine.call('task_start', { ticketId: created.id, expectedRevision: 1, requestId: 'start-00001' })
    assert.equal(store.effects().length, 0)
    engine.approve(store.approvals()[0]!.id, true)
    const queued = engine.require(created.id)
    assert.equal(stage(queued), 'queued')
    engine.call('task_stop', { ticketId: created.id, expectedRevision: queued.revision, requestId: 'stop-00001', reason: 'Wait for me' })
    engine.call('task_message', { ticketId: created.id, text: 'New clue, not permission to resume', requestId: 'message-0001' })
    engine.receiveFeedback(created.id, 'ci:1', 'CI changed')
    engine.recover()
    assert.equal(stage(engine.require(created.id)), 'stopped')
    assert.equal(engine.claim(store.effects('pending')[0]!), undefined)
  } finally { store.close() }
})
test('late reports cannot modify a stopped task and uncertain work is not replayed', () => {
  const { store, engine } = fixture()
  try {
    const created = ticketOf(engine.call('task_create', creation))
    engine.call('task_start', { ticketId: created.id, expectedRevision: 1, requestId: 'start-00001' })
    engine.approve(store.approvals()[0]!.id, true)
    const running = engine.claim(store.effects('pending')[0]!)!
    engine.recover()
    assert.equal(stage(engine.require(created.id)), 'reconciling')
    engine.call('task_stop', { ticketId: created.id, expectedRevision: engine.require(created.id).revision, requestId: 'stop-00002', reason: 'Stop' })
    assert.equal(engine.report(created.id, running.assignments[0]!.id, { state: 'ready', summary: 'late', checks: [] }), false)
    assert.equal(engine.require(created.id).stopping, true)
  } finally { store.close() }
})
test('transaction failures roll back tickets and effects together', () => {
  const { store } = fixture()
  try {
    assert.throws(() => store.atomic(() => { store.set('test', true); throw new Error('rollback') }))
    assert.equal(store.get('test'), undefined)
  } finally { store.close() }
})
