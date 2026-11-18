import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { Ticket, WorkerAgent } from '../core/src/model.js'
import { WorkerAgents } from '../executor-codex/src/agents.js'
import { createProfile, loadProfile, providerEnvironment, workerAgentsSchema } from '../executor-codex/src/profile.js'
import { effectiveProfile } from '../executor-codex/src/inspection.js'
import { AppServer } from '../executor-codex/src/rpc.js'

function fixture(maxConcurrent = 2) {
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo' })
  const engine = new Engine(store, 'human')
  const ticket = (engine.call('task_create', { repositoryId: 'repo', title: 'Delegated task', request: 'Review separate files', requestId: randomUUID() }) as { ticket: Ticket }).ticket
  const agents = new WorkerAgents(store, ticket.id, 'assignment', '/workspace', { enabled: true, maxConcurrent, maxDepth: 1 })
  const spawn = (threadId: string, status = 'running') => agents.observe({ method: 'item/completed', params: { threadId: 'parent', turnId: 'parent-turn', item: { id: `spawn-${threadId}`, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent', receiverThreadIds: [threadId], prompt: `Review ${threadId}`, agentsStates: { [threadId]: { status, message: null } } } } }, 'parent', 'parent-turn')
  const observe = (method: string, params: unknown) => agents.observe({ method, params }, 'parent', 'parent-turn')
  const rows = () => store.entities<WorkerAgent>('worker_agent')
  return { store, engine, ticket, agents, spawn, observe, rows }
}

test('native subagent configuration has bounded defaults and rejects unsafe depth and concurrency', () => {
  assert.deepEqual(workerAgentsSchema.parse({}), { enabled: true, maxConcurrent: 3, maxDepth: 1 })
  for (const config of [{ maxConcurrent: 0 }, { maxConcurrent: 5 }, { maxDepth: 2 }, { unknown: true }]) assert.equal(workerAgentsSchema.safeParse(config).success, false)
})

test('fixed Codex reads and enforces the reviewed native subagent profile; old profiles remain disabled', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-agent-policy-')))
  let server: AppServer | undefined
  try {
    const profile = await createProfile(root, 'fixture-model')
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    server = new AppServer('codex', ['app-server', '--listen', 'stdio://'], { cwd: workspace, env: await providerEnvironment(profile) })
    await server.initialize()
    const { config } = await server.request<{ config: any }>('config/read', { includeLayers: false })
    assert.equal(effectiveProfile(config, profile), true)
    assert.equal(config.features.multi_agent, true)
    assert.equal(config.features.multi_agent_v2, true)
    assert.equal(config.agents.max_concurrent_threads_per_session, 3)
    assert.equal(config.agents.max_depth, 1)
    assert.equal(effectiveProfile({ ...config, agents: { ...config.agents, max_depth: 2 } }, profile), false)
    assert.equal(effectiveProfile({ ...config, agents: { ...config.agents, max_concurrent_threads_per_session: 4 } }, profile), false)
    await server.close(); server = undefined
    await createProfile(root, 'fixture-model', undefined, workerAgentsSchema.parse({ enabled: false }))
    const legacy = JSON.parse(await readFile(join(root, 'worker-profile.json'), 'utf8'))
    delete legacy.agents
    await writeFile(join(root, 'worker-profile.json'), JSON.stringify(legacy), { mode: 0o600 })
    assert.equal((await loadProfile(root)).agents.enabled, false)
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }) }
})

test('subagent lifecycle is durable, deduplicated, visible, and never becomes task acceptance', () => {
  const context = fixture()
  try {
    context.spawn('child')
    context.spawn('child')
    context.observe('thread/started', { thread: { id: 'child', parentThreadId: 'parent', cwd: '/workspace', agentNickname: 'Reviewer', agentRole: 'explorer' } })
    context.observe('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    assert.equal(context.agents.owns('child', 'child-turn'), true)
    context.agents.verifyThread({ id: 'child', parentThreadId: 'parent', cwd: '/workspace', preview: 'Review selected files' })
    assert.equal(context.rows()[0]!.scope, 'Review selected files')
    assert.throws(() => context.agents.verifyThread({ id: 'child', parentThreadId: 'foreign', cwd: '/workspace' }), /metadata differs/)
    assert.throws(() => context.agents.verifyThread({ id: 'child', parentThreadId: 'parent', cwd: '/outside' }), /metadata differs/)
    context.observe('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', text: 'Reviewing', phase: 'commentary' } })
    context.observe('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', text: 'No issue in selected files', phase: 'final_answer' } })
    context.observe('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } })
    const [agent] = context.rows()
    assert.equal(agent!.status, 'completed')
    assert.equal(agent!.nickname, 'Reviewer')
    assert.equal(agent!.progress, 'Reviewing')
    assert.equal(agent!.summary, 'No issue in selected files')
    assert.equal(context.rows().length, 1)
    assert.equal(context.agents.owns('child', 'child-turn'), false)
    const detail = context.engine.view(context.engine.require(context.ticket.id))
    assert.equal(detail.agents.length, 1)
    assert.equal(detail.ticket.result, undefined)
    assert.equal(detail.ticket.report, undefined)
    context.agents.finish()
    assert.equal(context.rows()[0]!.cleanup, 'closed')
    assert.equal(context.rows()[0]!.status, 'completed')
  } finally { context.store.close() }
})

test('subagents cannot escape workspace, exceed bounds, nest, or communicate with foreign threads', () => {
  const context = fixture(1)
  try {
    context.spawn('child')
    assert.throws(() => context.spawn('overflow'), /concurrency/)
    assert.throws(() => context.observe('thread/started', { thread: { id: 'grandchild', parentThreadId: 'child', cwd: '/workspace' } }), /depth/)
    assert.throws(() => context.observe('thread/started', { thread: { id: 'escaped', parentThreadId: 'parent', cwd: '/other' } }), /workspace/)
    assert.throws(() => context.observe('item/completed', { threadId: 'parent', turnId: 'parent-turn', item: { id: 'foreign', type: 'collabAgentToolCall', tool: 'sendInput', status: 'completed', senderThreadId: 'parent', receiverThreadIds: ['other-task-agent'], agentsStates: {} } }), /outside this Assignment/)
    context.observe('item/completed', { threadId: 'parent', turnId: 'old-turn', item: { type: 'collabAgentToolCall' } })
    context.observe('turn/started', { threadId: 'foreign', turn: { id: 'foreign-turn' } })
    assert.equal(context.rows().length, 1)
    assert.equal(context.agents.owns('foreign', 'foreign-turn'), false)
    context.agents.finish(true)
    assert.equal(context.rows()[0]!.status, 'uncertain')
    assert.equal(context.rows()[0]!.cleanup, 'uncertain')
  } finally { context.store.close() }
})

test('subagent stale messages are ignored and cleanup closes unfinished children', () => {
  const context = fixture()
  try {
    context.spawn('child')
    context.observe('turn/started', { threadId: 'child', turn: { id: 'current' } })
    context.observe('item/completed', { threadId: 'child', turnId: 'old', item: { type: 'agentMessage', text: 'Stale output' } })
    assert.equal(context.rows()[0]!.summary, undefined)
    context.agents.finish()
    context.observe('item/completed', { threadId: 'child', turnId: 'current', item: { type: 'agentMessage', text: 'Late output' } })
    assert.equal(context.rows()[0]!.summary, undefined)
    assert.equal(context.rows()[0]!.status, 'shutdown')
  } finally { context.store.close() }
})

test('v2 parent activity registers children before their own turns and rejects nested task paths', () => {
  const context = fixture()
  try {
    const activity = { threadId: 'parent', turnId: 'parent-turn', item: { type: 'subAgentActivity', id: 'spawn-child', kind: 'started', agentThreadId: 'child', agentPath: '/root/reviewer' } }
    context.observe('item/started', activity)
    context.observe('turn/started', { threadId: 'child', turn: { id: 'child-turn' } })
    context.observe('item/completed', activity)
    assert.equal(context.rows().length, 1)
    assert.equal(context.rows()[0]!.status, 'running')
    assert.equal(context.rows()[0]!.nickname, '/root/reviewer')
    assert.equal(context.agents.owns('child', 'child-turn'), true)
    assert.throws(() => context.observe('item/started', { ...activity, item: { ...activity.item, agentThreadId: 'nested', agentPath: '/root/reviewer/nested' } }), /depth/)
    context.observe('item/completed', { ...activity, item: { ...activity.item, kind: 'completed' } })
    assert.equal(context.rows()[0]!.status, 'completed')
  } finally { context.store.close() }
})

test('recovery quarantines subagent state instead of claiming the children stopped', () => {
  const context = fixture()
  try {
    context.spawn('child')
    const current = context.engine.require(context.ticket.id)
    current.assignments.push({ id: 'assignment', generation: 1, state: 'running' })
    context.store.save(current)
    context.engine.recover()
    assert.equal(context.rows()[0]!.cleanup, 'uncertain')
    assert.equal(context.engine.require(current.id).reconciliation?.includes('uncertain'), true)
    assert.equal(context.engine.view(context.engine.require(current.id)).agents[0]!.historical, false)
  } finally { context.store.close() }
})
