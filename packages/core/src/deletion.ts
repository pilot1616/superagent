import { z } from 'zod'
import type { Engine } from './engine.js'
import { requireCondition, type Plan, type TaskEvent, type Thread, type WorkerAgent } from './model.js'

const identifier = z.string().min(1).max(150)
const revision = z.number().int().positive()
const member = z.object({ ticketId: identifier, expectedRevision: revision }).strict()
const requestId = z.string().min(8).max(150)
export const deletionSchemas = {
  'delete-task': member.extend({ requestId }).strict(),
  'delete-plan': z.object({ planId: identifier, expectedRevision: revision, tasks: z.array(member).min(1).max(100), requestId }).strict(),
}
export type DeletionAction = keyof typeof deletionSchemas

export function deleteRecords(engine: Engine, action: DeletionAction, raw: unknown, active: ReadonlySet<string> = new Set(), busy: ReadonlySet<string> = new Set()) {
  const params = deletionSchemas[action].parse(raw)
  const store = engine.store
  return store.once(engine.operatorId, action, params.requestId, params, () => {
    const plan = 'planId' in params ? engine.coordination.require<Plan>('plan', params.planId) : undefined
    requireCondition(!plan || plan.revision === params.expectedRevision, 'REVISION_CONFLICT', '计划已变化，请刷新后重新确认删除', 409)
    const members = 'tasks' in params ? params.tasks : [params]
    if (plan) requireCondition(members.length === plan.ticketIds.length && new Set(members.map(entry => entry.ticketId)).size === members.length && members.every(entry => plan.ticketIds.includes(entry.ticketId)), 'REVISION_CONFLICT', '必须确认计划的全部成员，不允许部分删除', 409)
    const tickets = members.map(entry => {
      const ticket = engine.require(entry.ticketId)
      requireCondition(ticket.revision === entry.expectedRevision, 'REVISION_CONFLICT', `任务「${ticket.title}」已变化，请刷新后重新确认删除`, 409)
      requireCondition(plan ? ticket.planId === plan.id : !ticket.planId && !store.entities<Plan>('plan').some(candidate => candidate.ticketIds.includes(ticket.id)), 'DEPENDENCY_CONFLICT', '计划成员不能单独删除，请在计划详情中删除整组', 409)
      requireCondition(!active.has(ticket.id) && !busy.has(ticket.id) && !ticket.stopping && !ticket.reconciliation && ticket.assignments.every(assignment => assignment.state === 'ended') && !store.effects().some(effect => effect.ticketId === ticket.id && effect.state !== 'done') && !store.entities<WorkerAgent>('worker_agent').some(agent => agent.ticketId === ticket.id && agent.cleanup !== 'closed'), 'TASK_BUSY', `任务「${ticket.title}」仍在执行、排队或等待清理核对，请先停止并完成核对`, 409)
      return ticket
    })
    const ids = new Set(tickets.map(ticket => ticket.id))
    const deletedAt = new Date().toISOString()
    const audit = { deletedAt, operatorId: engine.operatorId, requestId: params.requestId, retainedFiles: true }
    for (const thread of store.entities<Thread>('thread')) {
      const subscriptions = thread.subscriptions.filter(entry => !ids.has(entry.ticketId))
      if (subscriptions.length === thread.subscriptions.length) continue
      store.saveEntity('thread', thread.id, { ...thread, revision: thread.revision + 1, subscriptions })
      store.audit(thread.id, 'thread.deleted_tasks_unsubscribed', { ticketIds: [...ids] })
    }
    for (const event of store.entities<TaskEvent>('event')) {
      const removed = event.owners.filter(id => ids.has(id))
      const removedDecision = !!event.decision?.ticketId && ids.has(event.decision.ticketId)
      if (!removed.length && !removedDecision) continue
      event.owners = event.owners.filter(id => !ids.has(id))
      event.returned = [...new Set([...event.returned, ...removed])]
      if (!event.owners.length || removedDecision) delete event.decision
      store.saveEntity('event', event.id, event)
      store.audit(event.id, 'event.deleted_tasks_returned', { ticketIds: removed })
    }
    const targets = new Set([...ids, ...(plan ? [plan.id] : [])])
    for (const approval of store.approvals()) if (targets.has(approval.ticketId) && approval.status === 'pending') store.saveApproval({ ...approval, status: 'expired' })
    for (const ticket of tickets) {
      store.saveEntity('deleted_task', ticket.id, { ...audit, ticket })
      store.audit(ticket.id, 'task.deleted', { ...audit, planId: ticket.planId })
      store.removeTicket(ticket.id)
    }
    if (plan) {
      store.saveEntity('deleted_plan', plan.id, { ...audit, plan })
      store.audit(plan.id, 'plan.deleted', { ...audit, ticketIds: plan.ticketIds })
      store.removeEntity('plan', plan.id)
    }
    return { deleted: true, kind: plan ? 'plan' : 'task', id: plan?.id ?? tickets[0]!.id, deletedTaskIds: [...ids], deletedAt, retainedFiles: true }
  })
}
