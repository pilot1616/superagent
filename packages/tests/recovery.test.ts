import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { Ticket } from '../core/src/model.js'
import { candidates, scheduling } from '../core/src/scheduler.js'
import type { Plan } from '../core/src/model.js'

test('a crashed plan retains graph, grant, uncertain resource ownership and downstream blockers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sa-plan-crash-')), filename = join(root, 'tasks.sqlite')
  const worker = `import {Store} from './dist/storage/src/store.js';
import {Engine} from './dist/core/src/engine.js';
const store=new Store(process.argv[1]);store.set('repository',{id:'repo'});
const engine=new Engine(store,'human');
const {plan,mapping}=engine.call('plan_create',{repositoryId:'repo',title:'Crash plan',tasks:[{key:'first',title:'First',request:'Do first',resources:['database']},{key:'last',title:'Integration',request:'Integrate'}],dependencies:[{before:'first',after:'last',condition:'artifact'}],integrationKey:'last',expiresAt:new Date(Date.now()+3600000).toISOString(),requestId:'create-plan-0001'});
engine.call('plan_start',{planId:plan.id,expectedRevision:plan.revision,requestId:'start-plan-0001'});
const approval=store.approvals(plan.id)[0];engine.approve(approval.id,true,approval.details.fingerprint);
engine.claim(store.effects('pending').find(effect=>effect.ticketId===mapping.first));
process.kill(process.pid,'SIGKILL');`
  try {
    await assert.rejects(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, filename], { timeout: 10_000 }))
    const store = new Store(filename)
    try {
      const engine = new Engine(store, 'human'), plan = store.entities<Plan>('plan')[0]!
      assert.ok(plan.grant)
      engine.recover()
      const first = engine.require(plan.dependencies[0]!.before), last = engine.require(plan.integrationId)
      assert.equal(scheduling(store, first).state, 'reconciling')
      assert.equal(scheduling(store, last).state, 'waiting_dependencies')
      assert.equal(candidates(store, new Set(), new Set(), 4).length, 0)
      assert.equal(store.effects('uncertain').length, 1)
      const newTicket = (engine.call('task_create', { repositoryId: 'repo', title: 'Resource competitor', request: 'Independent database work', requestId: randomUUID() }) as { ticket: Ticket }).ticket
      newTicket.resources = ['database']; store.save(newTicket)
      engine.call('task_start', { ticketId: newTicket.id, expectedRevision: newTicket.revision, requestId: randomUUID() })
      engine.approve(store.approvals(newTicket.id)[0]!.id, true)
      assert.equal(scheduling(store, engine.require(newTicket.id)).state, 'waiting_resources')
      engine.reconcile(first.id, 'Verified killed fixture process and no external side effects', 'pending')
      assert.equal(scheduling(store, engine.require(newTicket.id)).state, 'ready')
      assert.equal(engine.require(first.id).mandate.humanHold, true)
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('committed WAL state survives abrupt process exit and uncertain input is never replayed implicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sa-recover-'))
  const path = join(root, 'tasks.sqlite')
  const worker = `import {Store} from './dist/storage/src/store.js';
import {Engine} from './dist/core/src/engine.js';
const store=new Store(process.argv[1]);
store.set('repository',{id:'repo',path:'/repo',executionRoot:'/worktrees',remote:'',baseRef:'main',baseSha:'a'.repeat(40)});
const engine=new Engine(store,'human');
const {ticket}=engine.call('task_create',{repositoryId:'repo',title:'Crash fixture',request:'Keep uncertainty',requestId:'create-0001'});
engine.call('task_start',{ticketId:ticket.id,expectedRevision:1,requestId:'start-0001'});
engine.approve(store.approvals()[0].id,true);
const running=engine.claim(store.effects('pending')[0]);
engine.updateExecution(ticket.id,running.assignments[0].id,current=>{current.inputs[0].state='sending'},'input.sending');
process.kill(process.pid,'SIGKILL');`
  try {
    await assert.rejects(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, path], { timeout: 10_000 }))
    const store = new Store(path)
    try {
      const engine = new Engine(store, 'human')
      assert.equal(store.tickets().length, 1)
      const ticket = store.tickets()[0]!
      assert.equal(ticket.inputs[0]!.state, 'sending')
      assert.equal(store.effects('running')[0]!.attempts, 1)
      assert.ok(store.effects('running')[0]!.lease?.owner)
      engine.recover()
      assert.ok(engine.require(ticket.id).reconciliation)
      assert.equal(store.effects('uncertain').length, 1)
      assert.equal(store.effects('pending').length, 0)
      assert.throws(() => engine.call('task_retry', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID() }), /reconciliation/)
      engine.reconcile(ticket.id, 'Verified fixture process died and input was not delivered', 'pending')
      assert.equal(engine.require(ticket.id).mandate.humanHold, true)
      assert.equal(engine.require(ticket.id).ended, 'stopped')
      assert.equal(engine.require(ticket.id).inputs[0]!.state, 'pending')
      assert.equal(store.effects('pending').length, 0)
    } finally { store.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('an effect is claimed once and ended assignments reject late callbacks', () => {
  const store = new Store(':memory:')
  try {
    store.set('repository', { id: 'repo' })
    const engine = new Engine(store, 'human')
    const { ticket } = engine.call('task_create', { repositoryId: 'repo', title: 'Once', request: 'Do once', requestId: randomUUID() }) as { ticket: Ticket }
    engine.call('task_start', { ticketId: ticket.id, expectedRevision: 1, requestId: randomUUID() })
    engine.approve(store.approvals()[0]!.id, true)
    const effect = store.effects('pending')[0]!
    const running = engine.claim(effect)!
    assert.equal(engine.claim(effect), undefined)
    engine.updateExecution(ticket.id, running.assignments[0]!.id, current => { current.inputs[0]!.state = 'accepted' }, 'input.accepted')
    engine.report(ticket.id, running.assignments[0]!.id, { state: 'ready', summary: 'Done locally', checks: [] })
    assert.equal(engine.updateExecution(ticket.id, running.assignments[0]!.id, current => { current.failure = 'late callback' }, 'late'), false)
    store.saveEffect({ ...store.effects('running')[0]!, state: 'done' })
    engine.complete(ticket.id)
    assert.equal(engine.require(ticket.id).ended, 'completed')
  } finally { store.close() }
})
test('stale stop effects cannot cancel a newer resumed assignment', () => {
  const store = new Store(':memory:')
  try {
    store.set('repository', { id: 'repo' })
    const engine = new Engine(store, 'human')
    const { ticket } = engine.call('task_create', { repositoryId: 'repo', title: 'Stop race', request: 'Stop generation test', requestId: randomUUID() }) as { ticket: Ticket }
    engine.call('task_start', { ticketId: ticket.id, expectedRevision: 1, requestId: randomUUID() })
    engine.approve(store.approvals()[0]!.id, true)
    engine.claim(store.effects('pending')[0]!)
    engine.call('task_stop', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID(), reason: 'Pause' })
    const stop = store.effects('pending').find(entry => entry.kind === 'stop')!
    engine.stopped(ticket.id)
    engine.call('task_resume', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID() })
    engine.approve(store.approvals().find(entry => entry.status === 'pending')!.id, true)
    assert.equal(engine.claim(stop), undefined)
    assert.equal(engine.require(ticket.id).assignments.at(-1)!.generation, 2)
    assert.equal(engine.require(ticket.id).mandate.humanHold, false)
  } finally { store.close() }
})
