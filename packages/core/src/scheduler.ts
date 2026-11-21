import { latestAssignment, type Effect, type Plan, type Ticket } from './model.js'
import type { Persistence } from './ports.js'
import { withinExecutionBudget } from './retry.js'

export interface Scheduling { state: string; reasons: string[]; reasonCodes?: string[] }
export function humanWake(ticket: Ticket): boolean {
  return ticket.assignments.length > 1 && ticket.inputs.some(entry => entry.state === 'pending' && entry.source === 'manual' && !entry.contextOnly && !entry.returned)
}
export function occupied(store: Persistence, active: ReadonlySet<string> = new Set()): Set<string> {
  return new Set([...active, ...store.tickets().filter(ticket => latestAssignment(ticket)?.state === 'running' || ticket.stopping || ticket.reconciliation).map(ticket => ticket.id), ...store.effects().filter(effect => effect.state === 'running' || effect.state === 'uncertain').map(effect => effect.ticketId)])
}
export function workerOccupied(store: Persistence, active: ReadonlySet<string> = new Set()): Set<string> {
  return new Set([...active, ...store.tickets().filter(ticket => latestAssignment(ticket)?.state === 'running' || ticket.stopping || (ticket.reconciliation && store.effects().some(effect => effect.ticketId === ticket.id && effect.kind !== 'publish' && effect.state === 'uncertain'))).map(ticket => ticket.id), ...store.effects().filter(effect => effect.kind !== 'publish' && (effect.state === 'running' || effect.state === 'uncertain')).map(effect => effect.ticketId)])
}
export function scheduling(store: Persistence, ticket: Ticket, active: ReadonlySet<string> = new Set(), ignoreWorkspace = false): Scheduling {
  const blocked = (state: string, ...reasons: string[]) => ({ state, reasons })
  if (ticket.reconciliation) return blocked('reconciling', ticket.reconciliation)
  if (ticket.mandate.humanHold || ticket.stopping) return blocked('held', 'Task has a human hold or is stopping')
  if (ticket.ended) return blocked('ended', ticket.ended)
  if (latestAssignment(ticket)?.state === 'running') return blocked('running')
  if (ticket.failure || ticket.report?.state === 'failed') return blocked('failed', ticket.failure ?? ticket.report!.summary)
  if (ticket.report?.state === 'blocked') return blocked('blocked', ticket.report.summary)
  if (ticket.report?.question) return blocked('waiting_input', ticket.report.question)
  if (store.get('paused')) return blocked('paused', 'Service dispatch is paused')
  if (ticket.planId) {
    const plan = store.entity<Plan>('plan', ticket.planId)
    if (!plan) return blocked('waiting_authorization', 'Missing plan')
    if (plan.held || plan.paused || plan.completed) return blocked(plan.held ? 'held' : 'paused', 'Plan is held, paused or completed')
    if (!plan.grant || plan.grant.version !== plan.version || Date.parse(plan.expiresAt) <= Date.now()) return blocked('waiting_authorization', 'Plan version needs unexpired human authorization')
    if (!withinExecutionBudget(store, ticket, plan)) return blocked('waiting_authorization', 'Plan execution budget exhausted; request human approval for one additional attempt')
    const missing = plan.dependencies.filter(edge => edge.after === ticket.id).filter(edge => {
      const upstream = store.ticket(edge.before)
      return !upstream?.result || upstream.result.kind !== edge.condition || upstream.mandate.humanHold || upstream.reconciliation || upstream.stopping
    })
    if (missing.length) return blocked('waiting_dependencies', ...missing.map(edge => `${edge.before}: requires accepted ${edge.condition}`))
  }
  if (!ticket.mandate.executionGranted) return blocked('waiting_authorization', 'Execution has not been authorized')
  const workspaceBlocker = store.get<{ bindingId?: string; reason: string; code: string }>(`workspace:blocker:${ticket.id}`)
  if (!ignoreWorkspace && workspaceBlocker && workspaceBlocker.bindingId === ticket.workspaceBinding?.id) return { state: 'waiting_workspace', reasons: [workspaceBlocker.reason], reasonCodes: [workspaceBlocker.code] }
  const holders = occupied(store, active)
  const conflicts = store.tickets().filter(other => other.id !== ticket.id && holders.has(other.id) && (latestAssignment(other)?.resources ?? other.resources)?.some(resource => ticket.resources?.includes(resource)))
  if (conflicts.length) return blocked('waiting_resources', ...conflicts.map(other => other.id))
  return blocked(latestAssignment(ticket)?.state === 'pending' ? 'ready' : latestAssignment(ticket)?.state === 'running' ? 'running' : 'idle')
}
export function validInputs(store: Persistence, ticket: Ticket): boolean {
  const assignment = latestAssignment(ticket)
  if (!ticket.planId) return true
  const plan = store.entity<Plan>('plan', ticket.planId)
  if (!plan || !assignment || assignment.planVersion !== plan.version && !ticket.result) return false
  const dependencies = plan.dependencies.filter(dependency => dependency.after === ticket.id)
  return dependencies.length === (assignment.inputs ?? []).length && dependencies.every(dependency => {
    const supplied = assignment.inputs?.find(result => result.ticketId === dependency.before)
    const accepted = store.ticket(dependency.before)?.result
    return supplied && accepted && supplied.id === accepted.id && supplied.hash === accepted.hash && accepted.kind === dependency.condition
  })
}
export function candidates(store: Persistence, active: ReadonlySet<string>, busy: ReadonlySet<string>, capacity: number): Effect[] {
  const launches = store.effects('pending').filter(effect => effect.kind === 'launch' && effect.dueAt <= Date.now())
  const preparing = launches.filter(effect => busy.has(effect.ticketId)).map(effect => effect.ticketId)
  const used = workerOccupied(store, new Set([...active, ...preparing]))
  const scored = launches.map(effect => ({ effect, ticket: store.ticket(effect.ticketId)! })).filter(entry => entry.ticket)
  const turns = new Map<string, number>()
  const compare = (left: typeof scored[number], right: typeof scored[number]) => {
    const human = Number(humanWake(right.ticket)) - Number(humanWake(left.ticket))
    if (human) return human
    const lastLeft = store.get<number>(`scheduler:last:${left.ticket.planId ?? left.ticket.id}`) ?? 0
    const lastRight = store.get<number>(`scheduler:last:${right.ticket.planId ?? right.ticket.id}`) ?? 0
    const score = (entry: typeof left) => (entry.ticket.priority ?? 0) + Math.floor((Date.now() - entry.effect.dueAt) / 60_000)
    return score(right) - score(left) || (turns.get(left.ticket.planId ?? left.ticket.id) ?? 0) - (turns.get(right.ticket.planId ?? right.ticket.id) ?? 0) || lastLeft - lastRight || left.effect.dueAt - right.effect.dueAt || left.ticket.id.localeCompare(right.ticket.id)
  }
  const selected: Effect[] = []
  while (scored.length) {
    scored.sort(compare)
    const { ticket, effect } = scored.shift()!
    if (used.has(ticket.id) || busy.has(ticket.id) || scheduling(store, ticket, used).state !== 'ready' || used.size >= capacity + Number(humanWake(ticket))) continue
    selected.push(effect); used.add(ticket.id)
    turns.set(ticket.planId ?? ticket.id, (turns.get(ticket.planId ?? ticket.id) ?? 0) + 1)
  }
  return selected
}
