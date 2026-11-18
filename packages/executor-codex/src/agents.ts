import { z } from 'zod'
import { requireCondition, type WorkerAgent } from '../../core/src/model.js'
import type { Persistence } from '../../core/src/ports.js'
import type { WorkerAgentsConfig } from './profile.js'
import type { RpcMessage } from './rpc.js'

const identifier = z.string().min(1).max(200)
const agentStatus = z.enum(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'])
const collaboration = z.object({ id: identifier, tool: z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents']), status: z.string(), senderThreadId: identifier, receiverThreadIds: z.array(identifier).max(32), prompt: z.string().nullish(), agentsStates: z.record(z.string(), z.object({ status: agentStatus, message: z.string().nullish() })).default({}) })

export class WorkerAgents {
  private agents = new Map<string, WorkerAgent>()
  constructor(private store: Persistence, private ticketId: string, private assignmentId: string, private workspace: string, private config: WorkerAgentsConfig) {}
  owns(threadId: unknown, turnId?: unknown): boolean {
    if (typeof threadId !== 'string') return false
    const agent = this.agents.get(threadId)
    return !!agent && !agent.cleanup && ['pendingInit', 'running'].includes(agent.status) && (turnId === undefined || !!agent.turnId && agent.turnId === turnId)
  }
  verifyThread(thread: { id: string; parentThreadId: string | null; cwd: string; preview?: string; agentRole?: string | null }): void {
    const agent = this.agents.get(thread.id)
    requireCondition(agent && thread.parentThreadId === agent.parentThreadId && thread.cwd === this.workspace, 'RUNTIME_FINGERPRINT_CHANGED', 'Subagent metadata differs from its assigned parent or workspace')
    if (!agent.cleanup) this.save({ ...agent, scope: thread.preview?.slice(0, 2000) || agent.scope, role: thread.agentRole?.slice(0, 160) ?? agent.role })
  }
  private save(agent: WorkerAgent): void {
    const previous = this.agents.get(agent.threadId)
    if (previous && JSON.stringify(previous) === JSON.stringify(agent)) return
    if (!agent.cleanup && ['pendingInit', 'running'].includes(agent.status)) requireCondition([...this.agents.values()].filter(other => other.threadId !== agent.threadId && !other.cleanup && ['pendingInit', 'running'].includes(other.status)).length < this.config.maxConcurrent, 'RUNTIME_UNSUPPORTED', 'Worker exceeded its subagent concurrency bound')
    agent = { ...agent, updatedAt: new Date().toISOString() }
    this.agents.set(agent.threadId, agent)
    this.store.saveEntity('worker_agent', agent.id, agent)
    if (previous?.status !== agent.status || previous?.cleanup !== agent.cleanup) this.store.audit(this.ticketId, 'worker.agent_state', { assignmentId: this.assignmentId, threadId: agent.threadId, parentThreadId: agent.parentThreadId, status: agent.status, cleanup: agent.cleanup })
  }
  private register(threadId: string, parentThreadId: string): WorkerAgent {
    requireCondition(this.config.enabled, 'RUNTIME_UNSUPPORTED', 'Subagents are disabled in the reviewed Worker profile')
    const previous = this.agents.get(threadId)
    if (previous) return previous
    requireCondition(this.agents.size < 32, 'RUNTIME_UNSUPPORTED', 'Worker exceeded its 32-subagent lifetime bound')
    const running = [...this.agents.values()].filter(agent => !agent.cleanup && ['pendingInit', 'running'].includes(agent.status))
    requireCondition(running.length < this.config.maxConcurrent, 'RUNTIME_UNSUPPORTED', 'Worker exceeded its subagent concurrency bound')
    const createdAt = new Date().toISOString()
    const agent: WorkerAgent = { id: `${this.assignmentId}:${threadId}`, ticketId: this.ticketId, assignmentId: this.assignmentId, threadId, parentThreadId, status: 'pendingInit', createdAt, updatedAt: createdAt }
    this.save(agent)
    return agent
  }
  observe(message: RpcMessage, rootThreadId: string, rootTurnId: string): void {
    const params = message.params as any
    if (message.method === 'thread/started') {
      const thread = params?.thread
      if (!thread?.parentThreadId) return
      requireCondition(!this.agents.has(thread.parentThreadId), 'RUNTIME_UNSUPPORTED', 'Nested subagents exceed the reviewed depth')
      if (thread.parentThreadId !== rootThreadId) return
      requireCondition(thread.cwd === this.workspace, 'RUNTIME_FINGERPRINT_CHANGED', 'Subagent escaped the assigned workspace')
      const agent = this.register(identifier.parse(thread.id), rootThreadId)
      this.save({ ...agent, nickname: typeof thread.agentNickname === 'string' ? thread.agentNickname.slice(0, 160) : agent.nickname, role: typeof thread.agentRole === 'string' ? thread.agentRole.slice(0, 160) : agent.role })
      return
    }
    const isRoot = params?.threadId === rootThreadId && params?.turnId === rootTurnId
    const child = typeof params?.threadId === 'string' ? this.agents.get(params.threadId) : undefined
    if (!isRoot && !child) return
    if (child?.cleanup) return
    if (['item/started', 'item/completed'].includes(message.method ?? '') && params.item?.type === 'subAgentActivity') {
      const item = params.item
      requireCondition(isRoot, 'RUNTIME_UNSUPPORTED', 'Only the task primary Agent may manage subagents')
      const threadId = identifier.parse(item.agentThreadId)
      requireCondition(typeof item.agentPath === 'string' && /^\/root\/[a-z0-9_]+$/.test(item.agentPath), 'RUNTIME_UNSUPPORTED', 'Subagent task path exceeds the reviewed depth')
      const agent = item.kind === 'started' ? this.register(threadId, rootThreadId) : this.agents.get(threadId)
      requireCondition(agent, 'FORBIDDEN', 'Subagent activity references an unknown Assignment thread')
      this.save({ ...agent, nickname: item.agentPath, status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : agent.status })
      return
    }
    if (message.method === 'turn/started' && child) {
      this.save({ ...child, turnId: identifier.parse(params.turn.id), status: 'running' })
      return
    }
    if (child && params?.turnId !== child.turnId && params?.turn?.id !== child.turnId) return
    if (message.method === 'item/completed' && params.item?.type === 'collabAgentToolCall') {
      const item = collaboration.parse(params.item)
      requireCondition(item.senderThreadId === params.threadId, 'FORBIDDEN', 'Agent message sender differs from the observed thread')
      requireCondition(isRoot || item.tool !== 'spawnAgent', 'RUNTIME_UNSUPPORTED', 'Only the task primary Agent may spawn subagents')
      const receivers = [...new Set([...item.receiverThreadIds, ...Object.keys(item.agentsStates)])]
      for (const receiver of receivers) {
        if (receiver === rootThreadId) continue
        const agent = item.tool === 'spawnAgent' ? this.register(receiver, rootThreadId) : this.agents.get(receiver)
        requireCondition(agent, 'FORBIDDEN', 'Agent communication references a thread outside this Assignment')
        const state = item.agentsStates[receiver]
        this.save({ ...agent, scope: item.tool === 'spawnAgent' ? item.prompt?.slice(0, 2000) ?? agent.scope : agent.scope, status: state?.status ?? agent.status, summary: state?.message?.slice(0, 4000) ?? agent.summary })
      }
    } else if (child && message.method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      this.save({ ...child, ...(params.item.phase === 'commentary' ? { progress: params.item.text.slice(0, 4000) } : { summary: params.item.text.slice(0, 4000) }) })
    } else if (child && message.method === 'turn/completed') {
      this.save({ ...child, status: params.turn.status === 'completed' ? 'completed' : params.turn.status === 'interrupted' ? 'interrupted' : 'errored' })
    }
  }
  finish(uncertain = false): void {
    for (const agent of this.agents.values()) this.save({ ...agent, status: uncertain ? 'uncertain' : ['pendingInit', 'running', 'interrupted'].includes(agent.status) ? 'shutdown' : agent.status, cleanup: uncertain ? 'uncertain' : 'closed' })
  }
}
