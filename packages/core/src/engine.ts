import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Persistence } from './ports.js'
import { DomainError, latestAssignment, requireCondition, stage, type Approval, type Binding, type Effect, type Report, type Ticket, type PublishPreview, type Pull } from './model.js'

const identifier = z.string().min(1).max(150)
const requestId = z.string().min(8).max(150)
const versioned = { ticketId: identifier, expectedRevision: z.number().int().positive(), requestId }
export const tools = {
  task_create: z.object({ repositoryId: identifier, title: z.string().trim().min(1).max(160), request: z.string().trim().min(1).max(30_000), requestId }).strict(),
  task_get: z.object({ ticketId: identifier, cursor: z.number().int().nonnegative().default(0) }).strict(),
  task_list: z.object({ stage: z.string().optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  task_message: z.object({ ...versioned, text: z.string().trim().min(1).max(30_000) }).strict(),
  task_start: z.object(versioned).strict(),
  task_resume: z.object(versioned).strict(),
  task_retry: z.object(versioned).strict(),
  task_stop: z.object({ ...versioned, reason: z.string().trim().min(1).max(1000) }).strict(),
  task_publish: z.object({ ...versioned, headSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
  health: z.object({}).strict(),
}
export const reportSchema = z.object({ state: z.enum(['waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string().min(1).max(20_000), checks: z.array(z.string().max(2000)).max(100), question: z.string().max(2000).nullable().default(null) }).strict()
const now = () => new Date().toISOString()
const input = (text: string, sequence: number, source: 'manual' | 'github' = 'manual') => ({ id: randomUUID(), text, sequence, source, state: 'pending' as const, createdAt: now() })

export class Engine {
  readonly runtimeId = randomUUID()
  constructor(readonly store: Persistence, readonly operatorId: string) {}
  require(id: string): Ticket {
    const ticket = this.store.ticket(id)
    if (!ticket) throw new DomainError('NOT_FOUND', 'Task not found', 404)
    return ticket
  }
  view(ticket: Ticket) {
    const approvals = this.store.approvals(ticket.id).filter(approval => approval.status === 'pending' && approval.expiresAt > now())
    return { ticket, stage: stage(ticket, approvals), approvals: approvals.map(({ id, kind, expiresAt, details }) => ({ id, kind, expiresAt, details })) }
  }
  private save(ticket: Ticket, event: string, detail: unknown = {}): void {
    ticket.revision++
    ticket.updatedAt = now()
    this.store.save(ticket)
    this.store.audit(ticket.id, event, detail)
  }
  private revision(ticket: Ticket, expected: number): void { requireCondition(ticket.revision === expected, 'REVISION_CONFLICT', `Current revision is ${ticket.revision}`) }
  private queue(ticket: Ticket): void {
    requireCondition(!ticket.mandate.humanHold && !ticket.ended && !ticket.reconciliation, 'INVALID_STATE', 'Task is held or needs reconciliation')
    requireCondition(!this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done'), 'INVALID_STATE', 'Publication must finish or reconcile before executing another assignment')
    const current = latestAssignment(ticket)
    if (current && current.state !== 'ended') return
    const assignment = { id: randomUUID(), generation: (current?.generation ?? 0) + 1, state: 'pending' as const }
    ticket.assignments.push(assignment)
    delete ticket.failure
    delete ticket.report
    this.store.saveEffect({ key: assignment.id, kind: 'launch', ticketId: ticket.id, generation: assignment.generation, payload: {}, state: 'pending', attempts: 0, dueAt: Date.now() })
  }
  call(name: keyof typeof tools, raw: unknown): unknown {
    this.expireApprovals()
    const parsed = tools[name].parse(raw) as any
    if (name === 'health') return { schemaVersion: 1, paused: this.store.get('paused') ?? false, pendingEffects: this.store.effects('pending').length }
    if (name === 'task_get') return { ...this.view(this.require(parsed.ticketId)), events: this.store.events(parsed.ticketId, parsed.cursor) }
    if (name === 'task_list') {
      const rows = this.store.tickets().map(ticket => this.view(ticket)).filter(row => !parsed.stage || row.stage === parsed.stage)
      return { items: rows.slice(parsed.cursor, parsed.cursor + parsed.limit).map(row => ({ id: row.ticket.id, title: row.ticket.title, revision: row.ticket.revision, stage: row.stage, updatedAt: row.ticket.updatedAt })), nextCursor: parsed.cursor + parsed.limit < rows.length ? parsed.cursor + parsed.limit : null }
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
      if (name === 'task_message') {
        requireCondition(!ticket.ended || ticket.ended === 'stopped', 'INVALID_STATE', 'Completed tasks require a new task')
        ticket.inputs.push(input(parsed.text, ticket.inputs.length + 1))
        if (ticket.mandate.executionGranted && !ticket.mandate.humanHold && !ticket.failure && !ticket.reconciliation && !ticket.report?.question && ticket.report?.state !== 'blocked' && ticket.report?.state !== 'failed' && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done')) this.queue(ticket)
        this.save(ticket, 'input.recorded', { inputId: ticket.inputs.at(-1)!.id })
        return this.view(ticket)
      }
      if (name === 'task_stop') {
        ticket.mandate.humanHold = true
        const current = latestAssignment(ticket)
        if (current?.state === 'running' || ticket.reconciliation || this.store.effects('running').some(effect => effect.ticketId === ticket.id && effect.kind === 'publish')) {
          ticket.stopping = true
          this.store.saveEffect({ key: `stop:${ticket.id}:${ticket.revision}`, kind: 'stop', ticketId: ticket.id, generation: current?.generation ?? 0, payload: {}, state: 'pending', attempts: 0, dueAt: Date.now() })
        } else { if (current) current.state = 'ended'; ticket.ended = 'stopped' }
        for (const approval of this.store.approvals(ticket.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
        this.save(ticket, 'task.stop_requested', { reason: parsed.reason })
        return this.view(ticket)
      }
      requireCondition(!ticket.stopping && !ticket.reconciliation, 'RECONCILIATION_REQUIRED', 'Task needs execution reconciliation')
      const kind = name.slice(5) as Approval['kind']
      if (kind === 'start') requireCondition(stage(ticket) === 'draft', 'INVALID_STATE', 'Only draft tasks can start')
      if (kind === 'resume') requireCondition(ticket.ended === 'stopped' || stage(ticket) === 'waiting' || stage(ticket) === 'answer', 'INVALID_STATE', 'Only stopped or idle tasks can resume')
      if (kind === 'retry') requireCondition(['failed', 'blocked'].includes(stage(ticket)), 'INVALID_STATE', 'Only failed or blocked tasks can retry')
      if (kind === 'publish') requireCondition(!ticket.ended && !ticket.mandate.humanHold && ticket.report?.state === 'ready' && latestAssignment(ticket)?.state === 'ended' && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done'), 'INVALID_STATE', 'Only ready, idle tasks without an ongoing publication may publish')
      requireCondition(!this.store.approvals(ticket.id).some(approval => approval.status === 'pending'), 'INVALID_STATE', 'Resolve the pending approval first')
      this.save(ticket, 'authorization.requested', { kind })
      const approval: Approval = { id: randomUUID(), ticketId: ticket.id, kind, status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), revision: ticket.revision, details: kind === 'publish' ? { headSha: parsed.headSha, scope: ticket.scope } : { scope: ticket.scope } }
      this.store.saveApproval(approval)
      return this.view(ticket)
    })
  }
  approve(id: string, accept: boolean): Approval {
    return this.store.atomic(() => {
      const approval = this.store.approval(id)
      requireCondition(approval?.status === 'pending', 'INVALID_STATE', 'Approval is not pending')
      requireCondition(approval.expiresAt > now(), 'INVALID_STATE', 'Approval expired')
      requireCondition(approval.kind !== 'runtime', 'INVALID_STATE', 'Runtime approval requires a live execution connection')
      const ticket = this.require(approval.ticketId)
      if (accept) this.revision(ticket, approval.revision)
      if (accept) {
        if (approval.kind === 'publish') throw new DomainError('APPROVAL_REQUIRED', 'Use the publish preview command to approve a specific diff')
        ticket.mandate.executionGranted = true
        ticket.mandate.humanHold = false
        delete ticket.ended
        this.queue(ticket)
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
  bind(ticketId: string, assignmentId: string, binding: Binding): void { this.updateExecution(ticketId, assignmentId, ticket => { ticket.binding = binding }, 'execution.bound') }
  report(ticketId: string, assignmentId: string, raw: unknown): boolean {
    const report: Report = reportSchema.parse(raw)
    return this.updateExecution(ticketId, assignmentId, ticket => {
      const assignment = latestAssignment(ticket)!
      requireCondition(assignment.state === 'running', 'INVALID_STATE', 'Assignment is not running')
      assignment.state = 'ended'; assignment.endedAt = now()
      for (const entry of ticket.inputs) if (entry.state === 'accepted') entry.state = 'settled'
      ticket.report = report
      if (ticket.binding) delete ticket.binding.turnId
      if (report.state === 'dropped') ticket.ended = 'completed'
      const waiting = ticket.inputs.some(entry => entry.state === 'pending')
      const external = ticket.inputs.some(entry => entry.state === 'pending' && entry.source === 'github')
      if (external && !ticket.ended) ticket.report = { ...report, question: 'New PR feedback requires scope review and an explicit resume before another turn.' }
      else if (waiting && !report.question && !['blocked', 'failed', 'dropped'].includes(report.state)) this.queue(ticket)
    }, 'execution.reported')
  }
  fail(ticketId: string, assignmentId: string, reason: string, uncertain = false): void {
    this.updateExecution(ticketId, assignmentId, ticket => {
      if (uncertain) ticket.reconciliation = reason
      else { ticket.failure = reason; latestAssignment(ticket)!.state = 'ended' }
    }, uncertain ? 'execution.uncertain' : 'execution.failed')
  }
  stopped(ticketId: string): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(ticket.mandate.humanHold, 'INVALID_STATE', 'Task has no human hold')
      const assignment = latestAssignment(ticket)
      if (assignment) { assignment.state = 'ended'; assignment.endedAt = now() }
      ticket.ended = 'stopped'; delete ticket.stopping; delete ticket.reconciliation
      this.save(ticket, 'task.stopped')
    })
  }
  receiveFeedback(ticketId: string, key: string, text: string): void {
    this.store.atomic(() => {
      if (this.store.observed(key)) return
      const ticket = this.require(ticketId)
      ticket.inputs.push(input(text.slice(0, 30_000), ticket.inputs.length + 1, 'github'))
      this.store.observe(key)
      if (latestAssignment(ticket)?.state !== 'running') ticket.report = { state: 'waiting', summary: 'PR feedback received; scope review and explicit resume required', checks: [], question: 'Does this feedback remain within the authorized task scope?' }
      this.save(ticket, 'github.feedback', { key })
    })
  }
  recover(): void {
    this.store.atomic(() => {
      for (const approval of this.store.approvals()) if (approval.status === 'pending' && (approval.kind === 'runtime' || approval.expiresAt <= now())) this.store.saveApproval({ ...approval, status: 'expired' })
      for (const effect of this.store.effects('running')) this.store.saveEffect({ ...effect, state: 'uncertain' })
      for (const ticket of this.store.tickets()) if (latestAssignment(ticket)?.state === 'running' || this.store.effects('uncertain').some(effect => effect.ticketId === ticket.id)) {
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
        if (approval.expiresAt <= now() || this.require(approval.ticketId).revision !== approval.revision) {
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
        requireCondition(effect.kind !== 'publish', 'RECONCILIATION_REQUIRED', 'External delivery requires separate PR reconciliation')
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
      requireCondition(!ticket.pull && !ticket.reconciliation && !ticket.mandate.humanHold && ticket.report?.state === 'ready' && latestAssignment(ticket)?.state === 'ended', 'INVALID_STATE', 'Only ready local work without a PR can be accepted')
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
  authorizePublish(approvalId: string, preview: PublishPreview): void {
    this.store.atomic(() => {
      const approval = this.store.approval(approvalId)
      requireCondition(approval?.kind === 'publish' && approval.status === 'pending' && approval.expiresAt > now(), 'INVALID_STATE', 'Publication approval expired')
      const ticket = this.require(approval.ticketId)
      this.revision(ticket, approval.revision)
      requireCondition(!ticket.mandate.humanHold && !ticket.reconciliation && !ticket.ended && latestAssignment(ticket)?.state === 'ended' && ticket.report?.state === 'ready', 'INVALID_STATE', 'Task is no longer idle and ready')
      requireCondition((approval.details.preview as PublishPreview | undefined)?.fingerprint === preview.fingerprint, 'REVISION_CONFLICT', 'Approved diff no longer matches the workspace')
      this.store.saveEffect({ key: `publish:${approvalId}`, kind: 'publish', ticketId: ticket.id, generation: latestAssignment(ticket)!.generation, payload: { preview }, state: 'pending', attempts: 0, dueAt: Date.now() })
      this.store.saveApproval({ ...approval, status: 'accepted' })
      this.save(ticket, 'publish.authorized', { approvalId, fingerprint: preview.fingerprint })
    })
  }
  syncPull(ticketId: string, pull: Pull): void {
    this.store.atomic(() => {
      const ticket = this.require(ticketId)
      requireCondition(pull.branch === ticket.branch && (!ticket.pull || ticket.pull.number === pull.number), 'FORBIDDEN', 'PR is not owned by this task')
      if (JSON.stringify(ticket.pull) === JSON.stringify(pull)) return
      ticket.pull = pull
      if (pull.state !== 'open' && !ticket.mandate.humanHold) ticket.ended = 'completed'
      this.save(ticket, 'github.pull_observed', { number: pull.number, state: pull.state, headSha: pull.headSha })
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
      if (effect.kind === 'publish' && (ticket.mandate.humanHold || ticket.ended || ticket.reconciliation || latestAssignment(ticket)?.generation !== effect.generation)) {
        this.store.saveEffect({ ...effect, state: 'done' }); return undefined
      }
      if (effect.kind === 'stop' && (!ticket.mandate.humanHold || latestAssignment(ticket)?.generation !== effect.generation)) {
        this.store.saveEffect({ ...effect, state: 'done' }); return undefined
      }
      this.store.saveEffect({ ...effect, state: 'running', attempts: effect.attempts + 1, lease: { owner: this.runtimeId, claimedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 } })
      if (effect.kind === 'launch') { latestAssignment(ticket)!.state = 'running'; latestAssignment(ticket)!.startedAt = now(); this.save(ticket, 'execution.starting') }
      return ticket
    })
  }
}
