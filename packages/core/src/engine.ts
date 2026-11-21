import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Persistence, RuntimeGate } from './ports.js'
import { Coordination, coordinationTools } from './coordination.js'
import { scheduling, validInputs } from './scheduler.js'
import { retryBudget } from './retry.js'
import { workspaceTools } from './workspace.js'
import type { Plan, WorkerAgent } from './model.js'
import { DomainError, latestAssignment, requireCondition, stage, type Approval, type Binding, type Checkpoint, type Effect, type Report, type Ticket, type PublishPreview, type MergeRequest } from './model.js'

const identifier = z.string().min(1).max(150)
const requestId = z.string().min(8).max(150)
const versioned = { ticketId: identifier, expectedRevision: z.number().int().positive(), requestId }
export const tools = {
  ...workspaceTools,
  ...coordinationTools,
  task_create: z.object({ repositoryId: identifier, title: z.string().trim().min(1).max(160), request: z.string().trim().min(1).max(30_000), requestId }).strict(),
  task_get: z.object({ ticketId: identifier, cursor: z.number().int().nonnegative().default(0), checkpointCursor: z.number().int().nonnegative().default(0) }).strict(),
  task_list: z.object({ stage: z.string().optional(), view: z.enum(['all', 'attention', 'active', 'finished']).default('all'), query: z.string().trim().max(160).default(''), planId: identifier.optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  task_message: z.object({ ...versioned, text: z.string().trim().min(1).max(30_000) }).strict(),
  task_adjust: z.object({ ...versioned, expectedPlanRevision: z.number().int().positive().optional(), title: z.string().trim().min(1).max(160), scope: z.string().trim().min(1).max(30_000), reason: z.string().trim().min(1).max(1000), priority: z.number().int().min(0).max(10), resources: z.array(z.string().regex(/^[\w:./-]{1,100}$/)).max(20) }).strict(),
  task_start: z.object(versioned).strict(),
  task_resume: z.object(versioned).strict(),
  task_retry: z.object(versioned).strict(),
  task_stop: z.object({ ...versioned, reason: z.string().trim().min(1).max(1000) }).strict(),
  task_publish: z.object({ ...versioned, headSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
  health: z.object({}).strict(),
}
export const reportSchema = z.object({ state: z.enum(['waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string().min(1).max(20_000), checks: z.array(z.string().max(2000)).max(100), question: z.string().max(2000).nullable().default(null) }).strict()
const now = () => new Date().toISOString()
const input = (text: string, sequence: number, source: 'manual' | 'gitlab' = 'manual') => ({ id: randomUUID(), text, sequence, source, state: 'pending' as const, createdAt: now() })

export class Engine {
  readonly runtimeId = randomUUID()
  readonly coordination: Coordination
  constructor(readonly store: Persistence, readonly operatorId: string, readonly runtimeBlocker?: () => string | undefined, readonly runtimeGate?: RuntimeGate) { this.coordination = new Coordination(this) }
  require(id: string): Ticket {
    const ticket = this.store.ticket(id)
    if (!ticket) throw new DomainError('NOT_FOUND', 'Task not found', 404)
    return ticket
  }
  view(ticket: Ticket) {
    const approvals = this.store.approvals(ticket.id).filter(approval => approval.status === 'pending' && approval.expiresAt > now())
    const plan = ticket.planId ? this.store.entity<Plan>('plan', ticket.planId) : undefined
    const agents = this.store.entities<WorkerAgent>('worker_agent').filter(agent => agent.ticketId === ticket.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 64).map(agent => ({ ...agent, historical: agent.assignmentId !== latestAssignment(ticket)?.id }))
    return { ticket, stage: stage(ticket, approvals), scheduling: this.decision(ticket), planAuthorized: plan ? plan.grant?.version === plan.version && !plan.held && !plan.completed && Date.parse(plan.expiresAt) > Date.now() : undefined, retryBudget: retryBudget(this.store, ticket), agents, approvals: approvals.map(({ id, kind, expiresAt, details }) => ({ id, kind, expiresAt, details })) }
  }
  decision(ticket: Ticket, active: ReadonlySet<string> = new Set()) {
    const decision = scheduling(this.store, ticket, active)
    const blocked = this.runtimeGate?.blocker()
    const reason = blocked?.reason ?? this.runtimeBlocker?.()
    return decision.state === 'ready' && reason ? { state: 'waiting_runtime', reasons: [reason], reasonCodes: blocked?.reasonCodes ?? ['RUNTIME_ENABLEMENT_REQUIRED'] } : decision
  }
  checkpoints(ticketId: string): Checkpoint[] {
    return this.store.entities<Checkpoint>('checkpoint').filter(entry => entry.ticketId === ticketId).reverse()
  }
  private historicalCheckpoint(ticket: Ticket, checkpoint: Checkpoint): boolean {
    const assignment = ticket.assignments.find(entry => entry.id === checkpoint.assignmentId)
    return !!ticket.restartThread || checkpoint.scope !== ticket.scope || !!ticket.planId && assignment?.planVersion !== this.store.entity<Plan>('plan', ticket.planId)?.version
  }
  progress(ticketId: string, assignmentId: string, itemId: string, text: string): boolean {
    if (!text.trim()) return false
    const id = `progress:${assignmentId}:${itemId}`
    if (this.store.entity('checkpoint', id)) return false
    return this.updateExecution(ticketId, assignmentId, ticket => {
      this.store.saveEntity('checkpoint', id, { id, ticketId, assignmentId, kind: 'progress', scope: ticket.scope, summary: text.slice(0, 20_000), checks: [], createdAt: now() } satisfies Checkpoint)
    }, 'execution.progress')
  }
  archiveReport(ticket: Ticket): void {
    const assignment = latestAssignment(ticket)
    if (!ticket.report || !assignment) return
    const id = `report:${assignment.id}`
    if (!this.store.entity('checkpoint', id)) this.store.saveEntity('checkpoint', id, { id, ticketId: ticket.id, assignmentId: assignment.id, kind: 'report', scope: ticket.scope, ...ticket.report, createdAt: assignment.endedAt ?? ticket.updatedAt } satisfies Checkpoint)
  }
  save(ticket: Ticket, event: string, detail: unknown = {}): void {
    ticket.revision++
    ticket.updatedAt = now()
    this.store.save(ticket)
    this.store.audit(ticket.id, event, detail)
  }
  private revision(ticket: Ticket, expected: number): void { requireCondition(ticket.revision === expected, 'REVISION_CONFLICT', `Current revision is ${ticket.revision}`) }
  queue(ticket: Ticket): void {
    requireCondition(!ticket.result, 'INVALID_STATE', 'Accepted results are immutable; create a new task for further work')
    requireCondition(!ticket.mandate.humanHold && !ticket.ended && !ticket.reconciliation, 'INVALID_STATE', 'Task is held or needs reconciliation')
    requireCondition(!this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done'), 'INVALID_STATE', 'Publication must finish or reconcile before executing another assignment')
    this.archiveReport(ticket)
    const current = latestAssignment(ticket)
    if (current && current.state !== 'ended') {
      if (current.state === 'pending') { delete ticket.failure; delete ticket.report }
      return
    }
    const assignment = { id: randomUUID(), generation: (current?.generation ?? 0) + 1, state: 'pending' as const }
    ticket.assignments.push(assignment)
    delete ticket.failure
    delete ticket.report
    this.store.saveEffect({ key: assignment.id, kind: 'launch', ticketId: ticket.id, generation: assignment.generation, payload: {}, state: 'pending', attempts: 0, dueAt: Date.now() })
  }
  call(name: keyof typeof tools, raw: unknown): unknown {
    requireCondition(!Object.hasOwn(workspaceTools, name), 'INVALID_STATE', 'Workspace operations require the project workspace service')
    this.expireApprovals()
    if (Object.hasOwn(coordinationTools, name)) return this.coordination.call(name as keyof typeof coordinationTools, raw)
    const parsed = tools[name].parse(raw) as any
    if (name === 'health') return { schemaVersion: 2, paused: this.store.get('paused') ?? false, pendingEffects: this.store.effects('pending').length, plans: this.store.entities<Plan>('plan').length }
    if (name === 'task_get') {
      const ticket = this.require(parsed.ticketId)
      const checkpoints = this.checkpoints(ticket.id)
      return { ...this.view(ticket), planRevision: ticket.planId ? this.store.entity<Plan>('plan', ticket.planId)?.revision : undefined, checkpoints: checkpoints.slice(parsed.checkpointCursor, parsed.checkpointCursor + 20).map(entry => ({ ...entry, historical: this.historicalCheckpoint(ticket, entry) })), checkpointTotal: checkpoints.length, nextCheckpointCursor: parsed.checkpointCursor + 20 < checkpoints.length ? parsed.checkpointCursor + 20 : null, events: this.store.events(ticket.id, parsed.cursor) }
    }
    if (name === 'task_list') {
      const rows = this.store.tickets().map(ticket => this.view(ticket)).filter(row => (!parsed.stage || row.stage === parsed.stage) && (!parsed.planId || row.ticket.planId === parsed.planId) && row.ticket.title.toLocaleLowerCase().includes(parsed.query.toLocaleLowerCase())).sort((left, right) => right.ticket.updatedAt.localeCompare(left.ticket.updatedAt) || left.ticket.id.localeCompare(right.ticket.id))
      const awaitingAcceptance = (row: ReturnType<Engine['view']>) => !row.ticket.result && row.ticket.report?.state === 'ready' && row.ticket.ended !== 'stopped' && (!row.ticket.ended || !!row.ticket.planId || row.ticket.mergeRequest?.state === 'merged')
      const active = (row: ReturnType<Engine['view']>) => !row.ticket.ended || awaitingAcceptance(row)
      const attention = (row: ReturnType<Engine['view']>) => ['draft', 'approval', 'answer', 'blocked', 'failed', 'reconciling', 'review'].includes(row.stage) || row.scheduling.state === 'waiting_workspace' || !!row.ticket.mandate.humanHold || awaitingAcceptance(row)
      const matches = (row: ReturnType<Engine['view']>) => parsed.view === 'all' || (parsed.view === 'finished' ? !active(row) : parsed.view === 'active' ? active(row) : active(row) && attention(row))
      const filtered = rows.filter(matches)
      const conclusions = new Map<string, Checkpoint>()
      for (const entry of this.store.entities<Checkpoint>('checkpoint')) conclusions.set(entry.ticketId, entry)
      return { items: filtered.slice(parsed.cursor, parsed.cursor + parsed.limit).map(row => {
        const conclusion = conclusions.get(row.ticket.id)
        const historical = conclusion && this.historicalCheckpoint(row.ticket, conclusion)
        return { id: row.ticket.id, title: row.ticket.title, revision: row.ticket.revision, stage: row.stage, scheduling: row.scheduling, planId: row.ticket.planId, updatedAt: row.ticket.updatedAt, awaitingAcceptance: awaitingAcceptance(row), acceptedBy: row.ticket.result ? row.ticket.result.acceptedBy ?? 'human' : undefined, summary: `${historical ? '历史结论：' : ''}${conclusion?.summary ?? row.ticket.report?.summary ?? ''}`.slice(0, 240) }
      }), total: filtered.length, counts: { all: rows.length, active: rows.filter(active).length, finished: rows.filter(row => !active(row)).length, attention: rows.filter(row => active(row) && attention(row)).length }, nextCursor: parsed.cursor + parsed.limit < filtered.length ? parsed.cursor + parsed.limit : null }
    }
    return this.store.once(this.operatorId, name, parsed.requestId, parsed, () => {
      if (name === 'task_create') {
        requireCondition(this.store.repository()?.id === parsed.repositoryId, 'FORBIDDEN', 'Repository is not registered')
        const ticket: Ticket = { id: randomUUID(), repositoryId: parsed.repositoryId, title: parsed.title, scope: parsed.request,
          revision: 1, createdAt: now(), updatedAt: now(), origin: { kind: 'manual', operatorId: this.operatorId, requestId: parsed.requestId },
          mandate: { operatorId: this.operatorId, scope: parsed.request, humanHold: false, executionGranted: false }, inputs: [input(parsed.request, 1)], assignments: [] }
        this.store.save(ticket)
        this.store.audit(ticket.id, 'task.created', { origin: ticket.origin })
        return this.view(ticket)
      }
      const ticket = this.require(parsed.ticketId)
      this.revision(ticket, parsed.expectedRevision)
      if (name === 'task_adjust') return this.adjust(ticket, parsed)
      if (name === 'task_message') {
        requireCondition(!ticket.result, 'INVALID_STATE', 'Accepted results are immutable; create a new task for further work')
        requireCondition(!ticket.ended || ticket.ended === 'stopped', 'INVALID_STATE', 'Completed tasks require a new task')
        ticket.inputs.push(input(parsed.text, ticket.inputs.length + 1))
        if (ticket.mandate.executionGranted && !ticket.mandate.humanHold && !ticket.failure && !ticket.reconciliation && !ticket.report?.question && ticket.report?.state !== 'blocked' && ticket.report?.state !== 'failed' && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done')) this.queue(ticket)
        this.save(ticket, 'input.recorded', { inputId: ticket.inputs.at(-1)!.id })
        return this.view(ticket)
      }
      if (name === 'task_stop') {
        requireCondition(!ticket.planId || !this.store.entity<Plan>('plan', ticket.planId)?.completed, 'INVALID_STATE', 'Completed plans are immutable')
        this.coordination.manualStop(ticket)
        ticket.mandate.humanHold = true
        const current = latestAssignment(ticket)
        if (current?.state === 'running' || ticket.reconciliation || this.store.effects('running').some(effect => effect.ticketId === ticket.id && effect.kind === 'publish')) {
          ticket.stopping = true
          this.store.saveEffect({ key: `stop:${ticket.id}:${ticket.revision}`, kind: 'stop', ticketId: ticket.id, generation: current?.generation ?? 0, payload: {}, state: 'pending', attempts: 0, dueAt: Date.now() })
        } else { if (current) current.state = 'ended'; ticket.ended = 'stopped' }
        for (const approval of this.store.approvals(ticket.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
        for (const effect of this.store.effects('pending')) if (effect.ticketId === ticket.id && effect.kind === 'launch') this.store.saveEffect({ ...effect, state: 'done' })
        this.save(ticket, 'task.stop_requested', { reason: parsed.reason })
        return this.view(ticket)
      }
      requireCondition(!ticket.stopping && !ticket.reconciliation, 'RECONCILIATION_REQUIRED', 'Task needs execution reconciliation')
      const kind = name.slice(5) as Approval['kind']
      if (kind === 'start') requireCondition(stage(ticket) === 'draft', 'INVALID_STATE', 'Only draft tasks can start')
      if (kind === 'resume') requireCondition(ticket.ended === 'stopped' || stage(ticket) === 'waiting' || stage(ticket) === 'answer', 'INVALID_STATE', 'Only stopped or idle tasks can resume')
      if (kind === 'retry') requireCondition(['failed', 'blocked'].includes(stage(ticket)) || (stage(ticket) === 'answer' && ticket.report?.state === 'blocked'), 'INVALID_STATE', 'Only failed or blocked tasks can retry')
      if (kind === 'retry' && ticket.planId) {
        const plan = this.coordination.require<Plan>('plan', ticket.planId)
        requireCondition(plan.grant?.version === plan.version && !plan.held && !plan.completed && !ticket.mandate.humanHold && Date.parse(plan.expiresAt) > Date.now(), 'APPROVAL_REQUIRED', 'Retry needs a current, unheld plan authorization')
        requireCondition(!this.store.approvals(ticket.id).some(approval => approval.status === 'pending'), 'INVALID_STATE', 'Resolve the pending task approval first')
        if ((latestAssignment(ticket)?.generation ?? 0) < plan.maxAttempts) {
          this.queue(ticket); this.save(ticket, 'plan.retry_requested', { planId: plan.id })
          return this.view(ticket)
        }
      }
      if (kind === 'publish') requireCondition(!ticket.ended && !ticket.mandate.humanHold && ticket.report?.state === 'ready' && latestAssignment(ticket)?.state === 'ended' && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done'), 'INVALID_STATE', 'Only ready, idle tasks without an ongoing publication may publish')
      if (kind === 'publish') requireCondition(validInputs(this.store, ticket), 'REVISION_CONFLICT', 'Dependency results changed')
      if (ticket.planId && ['start', 'resume'].includes(kind)) {
        const plan = this.coordination.require<Plan>('plan', ticket.planId)
        requireCondition(plan.grant?.version === plan.version && !plan.held && !plan.completed && Date.parse(plan.expiresAt) > Date.now(), 'APPROVAL_REQUIRED', 'Approve the current plan before requesting member execution')
      }
      requireCondition(!this.store.approvals(ticket.id).some(approval => approval.status === 'pending'), 'INVALID_STATE', 'Resolve the pending approval first')
      const plan = ticket.planId ? this.coordination.require<Plan>('plan', ticket.planId) : undefined
      const budget = retryBudget(this.store, ticket)
      const extension = plan && budget?.requiresApproval && ['retry', 'resume'].includes(kind) ? { extraAttempt: true, planId: plan.id, planVersion: plan.version, planFingerprint: plan.grant!.fingerprint, baseAttempts: budget.baseAttempts, assigned: budget.assigned, generation: budget.nextGeneration } : {}
      this.save(ticket, 'authorization.requested', { kind })
      const approval: Approval = { id: randomUUID(), ticketId: ticket.id, kind, status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), revision: ticket.revision, details: kind === 'publish' ? { headSha: parsed.headSha, scope: ticket.scope } : { scope: ticket.scope, ...extension } }
      this.store.saveApproval(approval)
      return this.view(ticket)
    })
  }
  private adjust(original: Ticket, params: z.infer<typeof tools.task_adjust>) {
    requireCondition(!original.result && original.ended !== 'completed', 'INVALID_STATE', 'Accepted or completed results are immutable; create a follow-up task')
    const plan = original.planId ? this.coordination.require<Plan>('plan', original.planId) : undefined
    if (plan) {
      requireCondition(plan.revision === params.expectedPlanRevision, 'REVISION_CONFLICT', 'Review the current plan revision before adjusting a member')
      requireCondition(!plan.completed, 'INVALID_STATE', 'Completed plans are immutable')
    }
    const affected = plan ? plan.ticketIds.map(id => this.require(id)).filter(ticket => !ticket.result && ticket.ended !== 'completed') : [original]
    requireCondition(affected.every(ticket => !ticket.stopping && !ticket.reconciliation && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done')), 'RECONCILIATION_REQUIRED', 'Wait for cleanup, reconciliation and publication before changing scope')
    if (plan) this.coordination.call('plan_stop', { planId: plan.id, expectedRevision: plan.revision, reason: params.reason, requestId: randomUUID() })
    else this.call('task_stop', { ticketId: original.id, expectedRevision: original.revision, reason: params.reason, requestId: randomUUID() })
    for (const member of affected) {
      const current = this.require(member.id)
      const assignment = latestAssignment(current)
      if (assignment?.state === 'running') assignment.resources ??= [...(current.resources ?? [])]
      this.archiveReport(current)
      current.mandate.executionGranted = false
      current.restartThread = true
      delete current.report
      delete current.failure
      this.save(current, 'task.reapproval_required', { reason: params.reason, previousScope: member.scope })
    }
    const ticket = this.require(original.id)
    const previousScope = ticket.scope
    ticket.title = params.title; ticket.scope = params.scope; ticket.mandate.scope = params.scope
    ticket.priority = params.priority; ticket.resources = [...new Set(params.resources)]
    for (const entry of ticket.inputs) if (entry.state === 'pending') { entry.state = 'settled'; entry.superseded = true }
    ticket.inputs.push(input(params.scope, ticket.inputs.length + 1))
    this.save(ticket, 'task.scope_adjusted', { previousScope, scope: params.scope, reason: params.reason })
    if (plan) {
      const current = this.coordination.require<Plan>('plan', plan.id)
      current.version++; current.revision++
      this.store.saveEntity('plan', current.id, current)
      this.store.audit(current.id, 'plan.scope_adjusted', { ticketId: ticket.id, version: current.version, reason: params.reason })
      for (const approval of this.store.approvals(current.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
    }
    return this.view(ticket)
  }
  approve(id: string, accept: boolean, expectedFingerprint?: string): Approval {
    return this.store.atomic(() => {
      const approval = this.store.approval(id)
      requireCondition(approval?.status === 'pending', 'INVALID_STATE', 'Approval is not pending')
      requireCondition(approval.expiresAt > now(), 'INVALID_STATE', 'Approval expired')
      requireCondition(approval.kind !== 'runtime', 'INVALID_STATE', 'Runtime approval requires a live execution connection')
      if (approval.kind === 'plan') return this.coordination.approve(approval, accept, expectedFingerprint)
      const ticket = this.require(approval.ticketId)
      if (accept) this.revision(ticket, approval.revision)
      if (accept) {
        if (approval.kind === 'publish') throw new DomainError('APPROVAL_REQUIRED', 'Use the publish preview command to approve a specific diff')
        if (ticket.planId) {
          const plan = this.coordination.require<Plan>('plan', ticket.planId)
          requireCondition(plan.grant?.version === plan.version && !plan.held && !plan.completed && Date.parse(plan.expiresAt) > Date.now(), 'APPROVAL_REQUIRED', 'Execution needs the current, unexpired goal authorization')
        }
        if (approval.details.extraAttempt === true) {
          const plan = ticket.planId ? this.coordination.require<Plan>('plan', ticket.planId) : undefined
          requireCondition(plan && ['retry', 'resume'].includes(approval.kind) && plan.grant?.version === plan.version && !plan.held && !plan.completed && Date.parse(plan.expiresAt) > Date.now() && approval.details.planId === plan.id && approval.details.planVersion === plan.version && approval.details.planFingerprint === plan.grant.fingerprint, 'APPROVAL_REQUIRED', 'Additional attempt needs the same current, unheld plan authorization')
          requireCondition(!ticket.stopping && !ticket.reconciliation && !ticket.result && latestAssignment(ticket)?.state === 'ended' && approval.details.generation === latestAssignment(ticket)!.generation + 1, 'REVISION_CONFLICT', 'Additional attempt no longer matches the next settled assignment')
        }
        ticket.mandate.executionGranted = true
        ticket.mandate.humanHold = false
        delete ticket.ended
        if (ticket.result) ticket.ended = 'completed'
        else {
          this.queue(ticket)
          if (approval.details.extraAttempt === true) {
            latestAssignment(ticket)!.retryApprovalId = approval.id
            approval.assignmentId = latestAssignment(ticket)!.id
            this.store.audit(ticket.id, 'retry.additional_attempt_authorized', { approvalId: approval.id, assignmentId: approval.assignmentId, generation: latestAssignment(ticket)!.generation, planId: ticket.planId })
          }
        }
      }
      approval.status = accept ? 'accepted' : 'declined'
      this.store.saveApproval(approval)
      this.save(ticket, 'authorization.decided', { approvalId: id, accept })
      return approval
    })
  }
  updateExecution(ticketId: string, assignmentId: string, action: (ticket: Ticket) => void, event: string): boolean {
    return this.store.atomic(() => {
      const ticket = this.require(ticketId)
      if (latestAssignment(ticket)?.id !== assignmentId || latestAssignment(ticket)?.state !== 'running' || ticket.mandate.humanHold || ticket.ended) return false
      action(ticket)
      this.save(ticket, event)
      return true
    })
  }
  bind(ticketId: string, assignmentId: string, binding: Binding): void { this.updateExecution(ticketId, assignmentId, ticket => { ticket.binding = binding; delete ticket.restartThread }, 'execution.bound') }
  report(ticketId: string, assignmentId: string, raw: unknown): boolean {
    const report: Report = reportSchema.parse(raw)
    return this.updateExecution(ticketId, assignmentId, ticket => {
      requireCondition(validInputs(this.store, ticket), 'REVISION_CONFLICT', 'Dependency result snapshot changed')
      const assignment = latestAssignment(ticket)!
      requireCondition(assignment.state === 'running', 'INVALID_STATE', 'Assignment is not running')
      assignment.state = 'ended'; assignment.endedAt = now(); assignment.launchPhase = 'ended'
      for (const entry of ticket.inputs) if (entry.state === 'accepted') entry.state = 'settled'
      ticket.report = report
      this.archiveReport(ticket)
      if (ticket.binding) delete ticket.binding.turnId
      if (report.state === 'dropped') ticket.ended = 'completed'
      const waiting = ticket.inputs.some(entry => entry.state === 'pending' && !entry.contextOnly && !entry.returned)
      const external = ticket.inputs.some(entry => entry.state === 'pending' && entry.source === 'gitlab')
      if (external && !ticket.ended) ticket.report = { ...report, question: 'New MR feedback requires scope review and an explicit resume before another turn.' }
      else if (waiting && !report.question && !['blocked', 'failed', 'dropped'].includes(report.state)) this.queue(ticket)
    }, 'execution.reported')
  }
  fail(ticketId: string, assignmentId: string, reason: string, uncertain = false): void {
    this.updateExecution(ticketId, assignmentId, ticket => {
      const id = `system:${assignmentId}:${uncertain ? 'uncertain' : 'failed'}`
      this.store.saveEntity('checkpoint', id, { id, ticketId, assignmentId, kind: 'system', scope: ticket.scope, summary: reason, checks: [], ...(uncertain ? {} : { state: 'failed' as const }), createdAt: now() } satisfies Checkpoint)
      if (uncertain) ticket.reconciliation = reason
      else { ticket.failure = reason; latestAssignment(ticket)!.state = 'ended'; latestAssignment(ticket)!.launchPhase = 'ended' }
    }, uncertain ? 'execution.uncertain' : 'execution.failed')
  }
  stopped(ticketId: string): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(ticket.mandate.humanHold, 'INVALID_STATE', 'Task has no human hold')
      const assignment = latestAssignment(ticket)
      if (assignment) { assignment.state = 'ended'; assignment.endedAt = now(); assignment.launchPhase = 'ended' }
      ticket.ended = 'stopped'; delete ticket.stopping; delete ticket.reconciliation
      this.save(ticket, 'task.stopped')
    })
  }
  receiveFeedback(ticketId: string, key: string, text: string): void {
    this.store.atomic(() => this.coordination.feedback(ticketId, key, text))
  }
  recover(): void {
    this.store.atomic(() => {
      for (const approval of this.store.approvals()) if (approval.status === 'pending' && (approval.kind === 'runtime' || approval.expiresAt <= now())) this.store.saveApproval({ ...approval, status: 'expired' })
      for (const effect of this.store.effects('running')) {
        if (effect.kind === 'publish' && effect.payload.phase === 'preflight' && !effect.payload.committedSha) this.failPublication(effect.key, 'Service restarted before delivery writes began; generate a fresh preview')
        else this.store.saveEffect({ ...effect, state: 'uncertain' })
      }
      for (const ticket of this.store.tickets()) if (latestAssignment(ticket)?.state === 'running' || this.store.effects('uncertain').some(effect => effect.ticketId === ticket.id)) {
        for (const agent of this.store.entities<WorkerAgent>('worker_agent').filter(agent => agent.ticketId === ticket.id && agent.cleanup !== 'closed')) this.store.saveEntity('worker_agent', agent.id, { ...agent, status: 'uncertain', cleanup: 'uncertain', updatedAt: now() })
        ticket.reconciliation = 'Service restarted with an uncertain operation; inspect the Codex thread, workspace and external delivery before retrying'
        this.save(ticket, 'recovery.required')
      }
      this.store.set('lastRecovery', { at: now(), uncertainTasks: this.store.tickets().filter(ticket => ticket.reconciliation).length })
    })
  }
  expireApprovals(): void {
    this.store.atomic(() => {
      for (const approval of this.store.approvals()) {
        if (approval.status !== 'pending' || approval.kind === 'runtime') continue
        const revision = approval.kind === 'plan' ? this.store.entity<Plan>('plan', approval.ticketId)?.revision : this.require(approval.ticketId).revision
        const plan = approval.details.extraAttempt === true ? this.store.entity<Plan>('plan', String(approval.details.planId)) : undefined
        const staleExtension = approval.details.extraAttempt === true && (!plan || plan.version !== approval.details.planVersion || plan.grant?.version !== plan.version || plan.grant.fingerprint !== approval.details.planFingerprint || plan.held || plan.completed || Date.parse(plan.expiresAt) <= Date.now())
        if (approval.expiresAt <= now() || revision !== approval.revision || staleExtension) {
          this.store.saveApproval({ ...approval, status: 'expired' })
          this.store.audit(approval.ticketId, 'authorization.expired', { approvalId: approval.id })
        }
      }
    })
  }
  reconcile(ticketId: string, note: string, disposition: 'settled' | 'pending'): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(ticket.reconciliation, 'INVALID_STATE', 'No uncertain operation to reconcile')
      requireCondition(note.trim().length >= 10, 'INVALID_STATE', 'Record what thread, process and workspace evidence was checked')
      for (const effect of this.store.effects('uncertain')) if (effect.ticketId === ticketId) {
        requireCondition(effect.kind !== 'publish', 'RECONCILIATION_REQUIRED', 'External delivery requires separate MR reconciliation')
        this.store.saveEffect({ ...effect, state: 'done' })
      }
      for (const entry of ticket.inputs) if (entry.state === 'sending' || entry.state === 'accepted') entry.state = disposition
      const assignment = latestAssignment(ticket)
      if (assignment) { assignment.state = 'ended'; assignment.endedAt = now() }
      ticket.mandate.humanHold = true
      ticket.ended = 'stopped'
      delete ticket.reconciliation
      delete ticket.stopping
      if (ticket.binding) delete ticket.binding.turnId
      this.save(ticket, 'recovery.confirmed', { note, disposition, operatorId: this.operatorId })
    })
  }
  complete(ticketId: string): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(!ticket.planId, 'INVALID_STATE', 'Plan tasks require explicit result acceptance')
      requireCondition(!ticket.ended && !ticket.stopping && !ticket.mergeRequest && !ticket.reconciliation && !ticket.mandate.humanHold && ticket.report?.state === 'ready' && latestAssignment(ticket)?.state === 'ended', 'INVALID_STATE', 'Only ready local work without a MR can be accepted')
      requireCondition(ticket.inputs.every(entry => entry.state === 'settled') && !this.store.effects().some(effect => effect.ticketId === ticketId && effect.state !== 'done') && !this.store.approvals(ticketId).some(approval => approval.status === 'pending' && approval.expiresAt > now()), 'INVALID_STATE', 'Resolve pending inputs, approvals and operations before accepting local delivery')
      ticket.ended = 'completed'
      this.save(ticket, 'delivery.accepted', { operatorId: this.operatorId })
    })
  }
  attachPreview(approvalId: string, preview: PublishPreview): void {
    this.store.atomic(() => {
      const approval = this.store.approval(approvalId)
      requireCondition(approval?.kind === 'publish' && approval.status === 'pending' && approval.expiresAt > now(), 'INVALID_STATE', 'Publication approval is not pending')
      this.revision(this.require(approval.ticketId), preview.revision)
      requireCondition(preview.headSha === approval.details.headSha && preview.ticketId === approval.ticketId, 'REVISION_CONFLICT', 'Publication head changed')
      this.store.saveApproval({ ...approval, details: { ...approval.details, preview } })
      this.store.audit(approval.ticketId, 'publish.previewed', { fingerprint: preview.fingerprint })
    })
  }
  authorizePublish(approvalId: string, preview: PublishPreview, expectedFingerprint: string): void {
    this.store.atomic(() => {
      const approval = this.store.approval(approvalId)
      requireCondition(approval?.kind === 'publish' && approval.status === 'pending' && approval.expiresAt > now(), 'INVALID_STATE', 'Publication approval expired')
      const ticket = this.require(approval.ticketId)
      this.revision(ticket, approval.revision)
      requireCondition(validInputs(this.store, ticket), 'REVISION_CONFLICT', 'Dependency result snapshot changed')
      requireCondition(!ticket.mandate.humanHold && !ticket.reconciliation && !ticket.ended && latestAssignment(ticket)?.state === 'ended' && ticket.report?.state === 'ready' && ticket.inputs.every(entry => entry.state === 'settled'), 'INVALID_STATE', 'Task is no longer idle and ready')
      requireCondition(expectedFingerprint && (approval.details.preview as PublishPreview | undefined)?.fingerprint === expectedFingerprint && preview.fingerprint === expectedFingerprint, 'REVISION_CONFLICT', 'Displayed publication preview no longer matches; inspect the new preview before approving')
      this.store.saveEffect({ key: `publish:${approvalId}`, kind: 'publish', ticketId: ticket.id, generation: latestAssignment(ticket)!.generation, payload: { preview, approvalId, phase: 'preflight', authorizedRevision: ticket.revision + 1 }, state: 'pending', attempts: 0, dueAt: Date.now() })
      this.store.saveApproval({ ...approval, status: 'accepted' })
      this.save(ticket, 'publish.authorized', { approvalId, fingerprint: preview.fingerprint })
    })
  }
  failPublication(effectKey: string, reason: string): void {
    this.store.atomic(() => {
      const effect = this.store.effects().find(entry => entry.key === effectKey)
      requireCondition(effect?.kind === 'publish' && effect.state !== 'done', 'INVALID_STATE', 'Publication is no longer active')
      const ticket = this.require(effect.ticketId)
      const noWrites = effect.payload.phase === 'preflight' && !effect.payload.committedSha
      this.store.saveEffect({ ...effect, state: noWrites ? 'done' : 'uncertain' })
      if (noWrites) {
        const approval = typeof effect.payload.approvalId === 'string' ? this.store.approval(effect.payload.approvalId) : undefined
        if (approval) this.store.saveApproval({ ...approval, status: 'expired' })
        if (latestAssignment(ticket)?.state === 'ended' && !this.store.effects('uncertain').some(entry => entry.ticketId === ticket.id)) delete ticket.reconciliation
      } else ticket.reconciliation = 'Publication may have produced side effects; inspect the persisted phase and remote state before retrying'
      this.save(ticket, noWrites ? 'publish.preflight_rejected' : 'effect.uncertain', { kind: 'publish', phase: effect.payload.phase ?? 'unknown', reason })
    })
  }
  syncMergeRequest(ticketId: string, mergeRequest: MergeRequest): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(mergeRequest.branch === ticket.branch && (!ticket.mergeRequest || ticket.mergeRequest.iid === mergeRequest.iid), 'FORBIDDEN', 'MR is not owned by this task')
      if (JSON.stringify(ticket.mergeRequest) === JSON.stringify(mergeRequest)) return
      ticket.mergeRequest = mergeRequest
      if (mergeRequest.state !== 'open' && !ticket.mandate.humanHold) ticket.ended = 'completed'
      this.save(ticket, 'gitlab.merge_request_observed', { iid: mergeRequest.iid, state: mergeRequest.state, headSha: mergeRequest.headSha })
    })
  }
  claim(effect: Effect): Ticket | undefined {
    return this.store.atomic(() => {
      const persisted = this.store.effects('pending').find(entry => entry.key === effect.key)
      if (!persisted || persisted.dueAt > Date.now()) return undefined
      effect = persisted
      const ticket = this.require(effect.ticketId)
      if (effect.kind === 'launch' && (ticket.mandate.humanHold || ticket.ended || ticket.reconciliation || latestAssignment(ticket)?.generation !== effect.generation || latestAssignment(ticket)?.state !== 'pending')) {
        this.store.saveEffect({ ...effect, state: 'done' }); return undefined
      }
      if (effect.kind === 'launch' && this.decision(ticket).state !== 'ready') return undefined
      if (effect.kind === 'publish' && (ticket.mandate.humanHold || ticket.ended || ticket.reconciliation || latestAssignment(ticket)?.generation !== effect.generation)) {
        this.store.saveEffect({ ...effect, state: 'done' }); return undefined
      }
      if (effect.kind === 'stop' && (!ticket.mandate.humanHold || latestAssignment(ticket)?.generation !== effect.generation)) {
        this.store.saveEffect({ ...effect, state: 'done' }); return undefined
      }
      this.store.saveEffect({ ...effect, state: 'running', attempts: effect.attempts + 1, lease: { owner: this.runtimeId, claimedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 } })
      if (effect.kind === 'launch') {
        const assignment = latestAssignment(ticket)!
        this.runtimeGate?.bind(ticket, assignment)
        if (ticket.planId) {
          const plan = this.coordination.require<Plan>('plan', ticket.planId)
          assignment.planVersion = plan.version
          assignment.inputs = plan.dependencies.filter(dependency => dependency.after === ticket.id).map(dependency => this.require(dependency.before).result!)
        }
        assignment.resources = [...(ticket.resources ?? [])]
        assignment.state = 'running'; assignment.startedAt = now()
        this.store.set(`scheduler:last:${ticket.planId ?? ticket.id}`, Date.now())
        this.save(ticket, 'execution.starting', { dependencies: assignment.inputs?.map(result => result.id) ?? [], planVersion: assignment.planVersion })
      }
      return ticket
    })
  }
  cancelPreparation(ticketId: string, assignmentId: string): boolean {
    return this.store.atomic(() => {
      const ticket = this.require(ticketId)
      const assignment = latestAssignment(ticket)
      if (!assignment || assignment.id !== assignmentId || assignment.state !== 'running' || ticket.reconciliation || ['turn_sending', 'turn_acknowledged', 'cleanup', 'ended'].includes(assignment.launchPhase ?? '')) return false
      const effect = this.store.effects('running').find(entry => entry.key === assignment.id)
      const failures = Number(effect?.payload.preparationFailures ?? 0) + 1
      assignment.state = failures >= 3 ? 'ended' : 'pending'
      assignment.launchPhase = 'claimed'
      delete assignment.startedAt
      delete assignment.runtimeFingerprint
      delete assignment.runtimeFence
      delete assignment.enablementId
      for (const input of ticket.inputs) if (input.state === 'sending') input.state = 'pending'
      if (failures >= 3) {
        assignment.launchPhase = 'ended'; assignment.endedAt = now()
        ticket.failure = 'Execution preparation failed three times before model delivery; inspect the environment and explicitly retry.'
      }
      if (effect) this.store.saveEffect({ ...effect, state: failures >= 3 ? 'done' : 'pending', payload: { ...effect.payload, preparationFailures: failures }, dueAt: Date.now() + Math.min(30_000, 1000 * 2 ** (failures - 1)), lease: undefined })
      this.save(ticket, 'execution.preparation_cancelled', { assignmentId, preparationFailures: failures, exhausted: failures >= 3 })
      return true
    })
  }
}
