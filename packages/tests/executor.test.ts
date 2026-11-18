import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Engine } from '../core/src/engine.js'
import type { Ticket } from '../core/src/model.js'
import { Store } from '../storage/src/store.js'
import { CodexExecutor } from '../executor-codex/src/executor.js'
import { WorkerAgents } from '../executor-codex/src/agents.js'
import { AppServerRpcError, type AppServer, type RpcMessage } from '../executor-codex/src/rpc.js'
import { mkdtemp, mkdir, realpath, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'

function fixture() {
  const store = new Store(':memory:')
  store.set('repository', { id: 'fixture' })
  const engine = new Engine(store, 'human')
  const { ticket } = engine.call('task_create', { repositoryId: 'fixture', title: 'Cleanup race', request: 'Verify lifecycle', requestId: randomUUID() }) as { ticket: Ticket }
  engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
  engine.approve(store.approvals()[0]!.id, true)
  const effect = store.effects('pending')[0]!
  engine.claim(effect)
  store.saveEffect({ ...effect, state: 'done' })
  const assignmentId = engine.require(ticket.id).assignments[0]!.id
  engine.updateExecution(ticket.id, assignmentId, current => {
    current.binding = { threadId: 'thread-fixture', turnId: 'turn-fixture', version: 'fixture', profileHash: 'fixture' }
    current.inputs[0]!.state = 'accepted'
  }, 'fixture.started')
  const executor = new CodexExecutor(store, engine, 'unused-state')
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  const closing = { promise, resolve, reject }
  let closeCalls = 0
  const sent: RpcMessage[] = []
  const active: NonNullable<ReturnType<typeof executor.active.get>> = {
    server: { child: { pid: 0 }, close: () => { closeCalls++; return closing.promise }, request: async () => ({}), send: (message: RpcMessage) => { sent.push(message) } } as unknown as AppServer,
    ticketId: ticket.id, assignmentId, timer: setTimeout(() => {}, 30_000), finishing: false, epoch: 'fixture', turnId: 'turn-fixture', pending: new Map(), acknowledged: true, notifications: [],
    report: JSON.stringify({ state: 'ready', summary: 'Ready locally', checks: [] }),
  }
  executor.active.set(ticket.id, active)
  return { store, engine, ticket, executor, active, closing, sent, closeCalls: () => closeCalls, cleanup: () => { clearTimeout(active.timer); store.close() } }
}

test('subagent questions use current child turn identity and parent cleanup covers every child', async () => {
  const context = fixture()
  try {
    context.active.agents = new WorkerAgents(context.store, context.ticket.id, context.active.assignmentId, '/workspace', { enabled: true, maxConcurrent: 2, maxDepth: 1 })
    await context.executor['notification'](context.active, { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'thread-fixture', cwd: '/workspace' } } })
    await context.executor['notification'](context.active, { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } })
    const params = { threadId: 'child', turnId: 'child-turn', itemId: 'child-question', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: 'Child', question: 'Which file?', isOther: true, isSecret: false, options: null }] }
    context.executor['requestApproval'](context.active, { id: 'child-request', method: 'item/tool/requestUserInput', params })
    const approval = context.store.approvals().find(entry => entry.kind === 'runtime')!
    assert.equal(approval.details.threadId, 'child')
    await context.executor.answerRuntime(approval.id, { choice: { answers: ['Selected file'] } })
    assert.equal(context.sent.at(-1)!.id, 'child-request')
    await context.executor['notification'](context.active, { method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', text: 'Not the task report', phase: 'final_answer' } } })
    assert.notEqual(context.active.report, 'Not the task report')
    context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Stop parent and all children' })
    const stopping = context.executor.stop(context.ticket.id)
    await delay(10)
    assert.equal(context.store.entities<any>('worker_agent')[0]!.cleanup, undefined)
    context.closing.resolve(); await stopping
    assert.equal(context.store.entities<any>('worker_agent')[0]!.cleanup, 'closed')
    assert.equal(context.store.entities<any>('worker_agent')[0]!.status, 'shutdown')
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup() }
})

test('subagent metadata hydration retries only temporary reads, never spawn or model mutations', async () => {
  const context = fixture()
  try {
    context.active.agents = new WorkerAgents(context.store, context.ticket.id, context.active.assignmentId, '/workspace', { enabled: true, maxConcurrent: 2, maxDepth: 1 })
    context.active.agents.observe({ method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'thread-fixture', cwd: '/workspace' } } }, 'thread-fixture', 'turn-fixture')
    let reads = 0
    context.active.server.request = async <Result>(method: string): Promise<Result> => {
      assert.equal(method, 'thread/read')
      if (++reads === 1) throw new AppServerRpcError(-32603)
      return { thread: { id: 'child', parentThreadId: 'thread-fixture', cwd: '/workspace', preview: 'Review selected files' } } as Result
    }
    await context.executor['checkAgent'](context.active, 'child')
    assert.equal(reads, 2)
    assert.equal(context.store.entities<any>('worker_agent')[0]!.scope, 'Review selected files')
    reads = 0
    context.active.server.request = async () => { reads++; throw new AppServerRpcError(-32600) }
    await assert.rejects(context.executor['checkAgent'](context.active, 'child'), /-32600/)
    assert.equal(reads, 1)
    context.active.finishing = true
    await context.executor['checkAgent'](context.active, 'child')
    assert.equal(reads, 1)
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup() }
})

test('concurrent stop callers await one in-flight cleanup before recording stopped', async () => {
  const context = fixture()
  try {
    const release = context.executor['release'](context.active)
    context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Stop during cleanup' })
    const stops = [context.executor.stop(context.ticket.id), context.executor.stop(context.ticket.id)]
    await delay(10)
    assert.equal(context.engine.view(context.engine.require(context.ticket.id)).stage, 'stopping')
    assert.equal(context.executor.active.has(context.ticket.id), true)
    assert.equal(context.closeCalls(), 1)
    context.closing.resolve()
    await Promise.all([release, ...stops])
    assert.equal(context.engine.view(context.engine.require(context.ticket.id)).stage, 'stopped')
    assert.equal(context.executor.active.size, 0)
    assert.equal(context.store.events(context.ticket.id).filter(event => event.event === 'task.stopped').length, 1)
  } finally { context.closing.resolve(); context.cleanup() }
})

test('completed turn publishes its report and queues follow-up only after process cleanup', async () => {
  const context = fixture()
  try {
    context.engine.call('task_message', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), text: 'Follow-up input' })
    const notification = context.executor['notification'](context.active, { method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } })
    await delay(10)
    assert.equal(context.engine.require(context.ticket.id).assignments.length, 1)
    assert.equal(context.engine.require(context.ticket.id).assignments[0]!.state, 'running')
    assert.equal(context.engine.require(context.ticket.id).report, undefined)
    context.closing.resolve()
    await notification
    assert.equal(context.executor.active.size, 0)
    assert.equal(context.engine.require(context.ticket.id).assignments.at(-1)!.generation, 2)
    assert.equal(context.store.effects('pending').length, 1)
  } finally { context.closing.resolve(); context.cleanup() }
})

test('failed process cleanup keeps the active execution and never reports a successful stop', async () => {
  const context = fixture()
  try {
    context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Stop' })
    const stopping = context.executor.stop(context.ticket.id)
    const rejected = assert.rejects(stopping, /termination unconfirmed/)
    await delay(10)
    context.closing.reject(new Error('termination unconfirmed'))
    await rejected
    assert.equal(context.executor.active.has(context.ticket.id), true)
    assert.ok(context.engine.require(context.ticket.id).reconciliation)
    assert.equal(context.engine.require(context.ticket.id).ended, undefined)
    await assert.rejects(context.executor.stop(context.ticket.id), /termination unconfirmed/)
    assert.equal(context.closeCalls(), 1)
  } finally { context.cleanup() }
})

test('stale cleanup cannot delete a newer active execution or overwrite its process record', async () => {
  const context = fixture()
  try {
    const cleanup = context.executor['release'](context.active)
    const replacement = { ...context.active, epoch: 'new-epoch', assignmentId: 'new-assignment', finishing: false, cleanup: undefined }
    context.executor.active.set(context.ticket.id, replacement)
    context.store.set(`process:${context.ticket.id}`, { epoch: replacement.epoch })
    context.closing.resolve()
    await cleanup
    assert.equal(context.executor.active.get(context.ticket.id), replacement)
    assert.deepEqual(context.store.get(`process:${context.ticket.id}`), { epoch: 'new-epoch' })
  } finally { context.closing.resolve(); context.cleanup() }
})

test('completed commentary checkpoints are persisted without exposing reasoning or replacing the final report', async () => {
  const context = fixture()
  try {
    const notify = (item: unknown, turnId = 'turn-fixture') => context.executor['notification'](context.active, { method: 'item/completed', params: { threadId: 'thread-fixture', turnId, item } })
    await notify({ id: 'reasoning-1', type: 'reasoning', text: 'Private reasoning is not a progress conclusion' })
    await notify({ id: 'progress-1', type: 'agentMessage', phase: 'commentary', text: '已完成接口排查，下一步验证错误路径。' })
    await notify({ id: 'progress-1', type: 'agentMessage', phase: 'commentary', text: 'Duplicate notification' })
    await notify({ id: 'old-turn', type: 'agentMessage', phase: 'commentary', text: 'Late stale progress' }, 'old-turn')
    assert.equal(context.engine.checkpoints(context.ticket.id).length, 1)
    assert.match(context.engine.checkpoints(context.ticket.id)[0]!.summary, /已完成接口排查/)
    assert.match(context.active.report!, /Ready locally/)
    context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Human stop' })
    await notify({ id: 'late-stop', type: 'agentMessage', phase: 'commentary', text: 'Must not appear after stop' })
    assert.equal(context.engine.checkpoints(context.ticket.id).length, 1)
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup() }
})

test('T10: requests preceding turn acknowledgement are bounded and resolved notifications need no thread field', async () => {
  const context = fixture()
  try {
    context.active.acknowledged = false
    const message: RpcMessage = { id: 'rpc-fixture', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'file-fixture', startedAtMs: Date.now(), reason: null, grantRoot: null } }
    context.executor['requestApproval'](context.active, message)
    assert.equal(context.store.approvals().filter(approval => approval.kind === 'runtime').length, 0)
    assert.equal(context.active.requests?.length, 1)
    context.active.acknowledged = true
    for (const request of context.active.requests?.splice(0) ?? []) context.executor['requestApproval'](context.active, request)
    const approval = context.store.approvals().find(entry => entry.kind === 'runtime')!
    assert.equal(approval.assignmentId, context.active.assignmentId)
    assert.equal(approval.details.turnId, 'turn-fixture')
    await context.executor['notification'](context.active, { method: 'serverRequest/resolved', params: { requestId: 'rpc-fixture' } })
    assert.equal(context.active.pending.size, 0)
    assert.equal(context.store.approval(approval.id)!.status, 'expired')
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup() }
})

test('T08/T09: answers are single-use current-turn input, not permission approval', async () => {
  const context = fixture()
  try {
    const params = { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'question-fixture', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: 'Fixture', question: 'Which fixture?', isOther: true, isSecret: false, options: null }] }
    context.executor['requestApproval'](context.active, { id: 42, method: 'item/tool/requestUserInput', params })
    const approval = context.store.approvals().find(entry => entry.kind === 'runtime')!
    await assert.rejects(context.executor.decideRuntime(approval.id, true), /Permission expansion/)
    await context.executor.answerRuntime(approval.id, { choice: { answers: ['Fixture A'] } })
    assert.deepEqual(context.sent.at(-1), { id: 42, result: { answers: { choice: { answers: ['Fixture A'] } } } })
    assert.equal(context.store.entity<{ state: string }>('runtime_approval_delivery', approval.id)!.state, 'sent')
    assert.equal(context.store.entity<{ state: string }>('runtime_input_request', approval.id)!.state, 'sent')
    await context.executor['notification'](context.active, { method: 'serverRequest/resolved', params: { requestId: 42 } })
    assert.equal(context.store.entity<{ state: string }>('runtime_approval_delivery', approval.id)!.state, 'resolved')
    assert.equal(context.store.entity<{ state: string }>('runtime_input_request', approval.id)!.state, 'resolved')
    await assert.rejects(context.executor.answerRuntime(approval.id, { choice: { answers: ['A second reply'] } }), /expired or was already answered/)
    context.executor['requestApproval'](context.active, { id: 43, method: 'item/tool/requestUserInput', params: { ...params, turnId: 'previous-turn' } })
    assert.equal(context.store.approvals().filter(entry => entry.kind === 'runtime').length, 1)
    assert.equal(context.sent.at(-1)!.error?.code, -32600)
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup() }
})

test('task temporary files are preserved until process cleanup and excluded before reporting', async () => {
  const context = fixture()
  const workspace = await realpath(await mkdtemp('/tmp/sa-worker-temp-'))
  const temporary = join(workspace, '.superagent-tmp-fixture')
  await mkdir(temporary, { mode: 0o700 }); await writeFile(join(temporary, 'tool-output'), 'fixture')
  context.active.workspace = workspace; context.active.temporary = temporary
  try {
    const reporting = context.executor['notification'](context.active, { method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed' } } })
    await delay(10)
    await access(temporary)
    assert.equal(context.engine.require(context.ticket.id).report, undefined)
    context.closing.resolve(); await reporting
    await assert.rejects(access(temporary), { code: 'ENOENT' })
    assert.equal(context.engine.require(context.ticket.id).report!.state, 'ready')
  } finally { context.closing.resolve(); await context.executor['release'](context.active); context.cleanup(); await rm(workspace, { recursive: true, force: true }) }
})
