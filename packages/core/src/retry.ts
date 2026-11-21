import { latestAssignment, type Plan, type Ticket } from './model.js'
import type { Persistence } from './ports.js'

export function retryBudget(store: Persistence, ticket: Ticket) {
  const plan = ticket.planId ? store.entity<Plan>('plan', ticket.planId) : undefined
  if (!plan) return undefined
  const assigned = latestAssignment(ticket)?.generation ?? 0
  return { baseAttempts: plan.maxAttempts, assigned, remaining: Math.max(0, plan.maxAttempts - assigned), nextGeneration: assigned + 1, requiresApproval: assigned >= plan.maxAttempts }
}

export function withinExecutionBudget(store: Persistence, ticket: Ticket, plan: Plan): boolean {
  const assignment = latestAssignment(ticket)
  if (!assignment || assignment.generation <= plan.maxAttempts) return true
  const approval = assignment.retryApprovalId ? store.approval(assignment.retryApprovalId) : undefined
  return !!approval && approval.status === 'accepted' && ['retry', 'resume'].includes(approval.kind) && approval.ticketId === ticket.id && approval.assignmentId === assignment.id && approval.details.extraAttempt === true && approval.details.planId === plan.id && approval.details.planVersion === plan.version && approval.details.planFingerprint === plan.grant?.fingerprint && approval.details.generation === assignment.generation
}
