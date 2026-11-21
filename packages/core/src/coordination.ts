import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Engine } from './engine.js'
import { DomainError, latestAssignment, requireCondition, type AcceptedResult, type Approval, type Dependency, type Plan, type TaskEvent, type Thread, type Ticket } from './model.js'
import { validInputs } from './scheduler.js'
import { workspaceInput, workspaceBinding } from './workspace.js'

const identifier = z.string().min(1).max(150)
const requestId = z.string().min(8).max(150)
const text = z.string().trim().min(1).max(30_000)
const revision = z.number().int().positive()
const pagination = { cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) }
const edge = z.object({ before: identifier, after: identifier, condition: z.enum(['artifact', 'code']) }).strict()
const constraints = { priority: z.number().int().min(0).max(10).default(0), resources: z.array(z.string().regex(/^[\w:./-]{1,100}$/)).max(20).default([]) }
const versionedPlan = { planId: identifier, expectedRevision: revision, requestId }
const workflow = z.object({ automaticHandoffs: z.boolean().default(true), materialPaths: z.array(z.string().min(1).max(4096).startsWith('/')).max(10).default([]) }).strict()
export const coordinationTools = {
  thread_create: z.object({ title: z.string().trim().min(1).max(160), requestId }).strict(),
  thread_get: z.object({ threadId: identifier, ...pagination }).strict(),
  thread_list: z.object(pagination).strict(),
  thread_subscribe: z.object({ threadId: identifier, expectedRevision: revision, ticketId: identifier, mode: z.enum(['owning', 'context', 'remove']), requestId }).strict(),
  thread_unrelated: z.object({ threadId: identifier, expectedRevision: revision, ticketId: identifier, expectedTicketRevision: revision, reason: text, requestId }).strict(),
  event_record: z.object({ threadIds: z.array(identifier).min(1).max(20), text, source: z.enum(['manual', 'gitlab']).default('manual'), requestId }).strict(),
  route_context: z.object({ eventId: identifier }).strict(),
  task_route: z.object({ items: z.array(z.object({ eventId: identifier, kind: z.enum(['accept', 'attach', 'ignore', 'stop']), ticketId: identifier.optional(), expectedRevision: revision.optional(), title: z.string().trim().min(1).max(160).optional(), reason: z.string().trim().min(1).max(1000) }).strict()).min(1).max(30), requestId }).strict(),
  task_handback: z.object({ ticketId: identifier, expectedRevision: revision, eventId: identifier, reason: text, requestId }).strict(),
  plan_create: z.object({ repositoryId: identifier, title: z.string().trim().min(1).max(160), tasks: z.array(z.object({ key: identifier, title: z.string().trim().min(1).max(160), request: text, reviewRequired: z.boolean().default(false), ...constraints }).strict()).min(1).max(100), dependencies: z.array(edge).max(500), integrationKey: identifier, maxAttempts: z.number().int().min(1).max(10).default(3), expiresAt: z.iso.datetime(), workflow: workflow.default({ automaticHandoffs: true, materialPaths: [] }), workspace: workspaceInput.optional(), requestId }).strict(),
  plan_get: z.object({ planId: identifier }).strict(),
  plan_list: z.object(pagination).strict(),
  plan_update: z.object({ ...versionedPlan, dependencies: z.array(edge).max(500), tasks: z.array(z.object({ ticketId: identifier, ...constraints }).strict()).max(100), maxAttempts: z.number().int().min(1).max(10), expiresAt: z.iso.datetime() }).strict(),
  plan_start: z.object(versionedPlan).strict(),
  plan_pause: z.object({ ...versionedPlan, paused: z.boolean() }).strict(),
  plan_stop: z.object({ ...versionedPlan, reason: text }).strict(),
}
export const readOperations = ['task_get', 'task_list', 'health', 'thread_get', 'thread_list', 'route_context', 'plan_get', 'plan_list', 'plan_workspace_preview']
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()

export function validateGraph(ids: string[], edges: Dependency[], integrationId: string): void {
  requireCondition(new Set(ids).size === ids.length && ids.includes(integrationId), 'INVALID_GRAPH', 'Task keys must be unique and include the integration task')
  const visited = new Set<string>(), visiting = new Set<string>(), unique = new Set<string>()
  for (const dependency of edges) {
    const key = JSON.stringify([dependency.before, dependency.after])
    requireCondition(ids.includes(dependency.before) && ids.includes(dependency.after) && dependency.before !== dependency.after && !unique.has(key), 'INVALID_GRAPH', 'Dependency is duplicate, self-referencing or outside this plan')
    unique.add(key)
  }
  for (const id of ids) requireCondition(new Set(edges.filter(dependency => dependency.before === id).map(dependency => dependency.condition)).size <= 1, 'INVALID_GRAPH', 'A task produces one accepted result kind; use separate artifact and code tasks')
  const visit = (id: string) => {
    requireCondition(!visiting.has(id), 'INVALID_GRAPH', 'Dependency cycle detected')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of edges.filter(entry => entry.before === id)) visit(dependency.after)
    visiting.delete(id); visited.add(id)
  }
  ids.forEach(visit)
  const ancestors = new Set([integrationId])
  for (let pass = 0; pass < ids.length; pass++) for (const dependency of edges) if (ancestors.has(dependency.after)) ancestors.add(dependency.before)
  requireCondition(ancestors.size === ids.length, 'INVALID_GRAPH', 'Integration task must depend transitively on every required task')
}

export class Coordination {
  constructor(private engine: Engine) {}
  private get store() { return this.engine.store }
  require<Result>(kind: string, id: string): Result {
    const result = this.store.entity<Result>(kind, id)
    requireCondition(result, 'NOT_FOUND', `${kind} not found`)
    return result
  }
  private save(kind: 'thread' | 'plan', entity: Thread | Plan, event: string): void {
    entity.revision++
    this.store.saveEntity(kind, entity.id, entity)
    this.store.audit(entity.id, event, { revision: entity.revision })
  }
  private check(actual: number, expected: number): void { requireCondition(actual === expected, 'REVISION_CONFLICT', `Current revision is ${actual}`) }
  planView(plan: Plan) {
    const tasks = plan.ticketIds.map(id => this.engine.view(this.engine.require(id)))
    const counts: Record<string, number> = {}
    for (const task of tasks) counts[task.scheduling.state] = (counts[task.scheduling.state] ?? 0) + 1
    const accepted = tasks.filter(task => task.ticket.result).length
    const outcome = plan.completed ? 'completed' : plan.held ? 'stopped' : tasks.some(task => task.ticket.reconciliation) ? 'reconciling' : tasks.some(task => task.ticket.report?.state === 'dropped') ? 'incomplete' : accepted ? 'partially_accepted' : plan.paused ? 'paused' : 'pending'
    return { plan, tasks, counts, outcome, acceptedResults: accepted, requiredResults: tasks.length, approvals: this.store.approvals(plan.id).filter(approval => approval.status === 'pending') }
  }
  private spec(plan: Plan) {
    return { planId: plan.id, version: plan.version, title: plan.title, dependencies: plan.dependencies, integrationId: plan.integrationId, maxAttempts: plan.maxAttempts, expiresAt: plan.expiresAt,
      ...(plan.workflow ? { workflow: plan.workflow } : {}),
      ...(plan.workspace ? { workspace: plan.workspace } : {}),
      tasks: plan.ticketIds.map(id => { const ticket = this.engine.require(id); return { id, scope: ticket.scope, title: ticket.title, resources: ticket.resources, priority: ticket.priority, ...(plan.workflow ? { reviewRequired: ticket.reviewRequired ?? false } : {}) } }) }
  }
  private subscribe(thread: Thread, ticketId: string, mode: 'owning' | 'context', origin = false): void {
    const prior = thread.subscriptions.find(entry => entry.ticketId === ticketId)
    if (prior) { if (mode === 'owning') prior.mode = mode; if (origin) prior.origin = true }
    else thread.subscriptions.push({ ticketId, mode, ...(origin ? { origin } : {}) })
    this.save('thread', thread, 'thread.subscribed')
  }
  private deliver(event: TaskEvent, ticket: Ticket, contextOnly: boolean): void {
    if (ticket.mandate.humanHold || ticket.stopping || ticket.ended || event.delivered.includes(ticket.id)) return
    ticket.inputs.push({ id: randomUUID(), text: event.text, source: event.source, sequence: ticket.inputs.length + 1, state: 'pending', createdAt: now(), eventId: event.id, contextOnly })
    event.delivered.push(ticket.id)
    if (!contextOnly && event.source === 'manual') event.owners.push(ticket.id)
    if (!contextOnly && event.source === 'manual' && ticket.mandate.executionGranted && !ticket.reconciliation && !ticket.failure && !ticket.report?.question && !['blocked', 'failed'].includes(ticket.report?.state ?? '') && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.kind === 'publish' && effect.state !== 'done')) this.engine.queue(ticket)
    else if (event.source === 'gitlab' && latestAssignment(ticket)?.state !== 'running') ticket.report = { state: 'waiting', summary: 'Related external feedback received', checks: [], question: 'Review external feedback scope before explicitly resuming.' }
    this.engine.save(ticket, 'event.delivered', { eventId: event.id, contextOnly })
  }
  feedback(ticketId: string, key: string, text: string): void {
    if (this.store.observed(key)) return
    const threadId = `gitlab:${ticketId}`
    if (!this.store.entity<Thread>('thread', threadId)) this.store.saveEntity('thread', threadId, { id: threadId, title: `GitLab MR: ${ticketId}`, revision: 1, correlated: [], subscriptions: [{ ticketId, mode: 'owning', origin: true }] } satisfies Thread)
    this.call('event_record', { threadIds: [threadId], text: text.slice(0, 30_000), source: 'gitlab', requestId: fingerprint({ ticketId, key }) })
    this.store.observe(key)
    this.store.audit(ticketId, 'gitlab.feedback', { key, threadId })
  }
  call(name: keyof typeof coordinationTools, raw: unknown): unknown {
    const params = coordinationTools[name].parse(raw) as any
    if (name === 'plan_get') return this.planView(this.require<Plan>('plan', params.planId))
    if (name === 'route_context') {
      const event = this.require<TaskEvent>('event', params.eventId)
      const threads = event.threadIds.map(id => this.require<Thread>('thread', id))
      const related = new Set(threads.flatMap(thread => [...thread.subscriptions.map(entry => entry.ticketId), ...thread.correlated.flatMap(id => this.require<Thread>('thread', id).subscriptions.map(entry => entry.ticketId))]))
      return { event, threads, relatedTasks: [...related].slice(0, 100).map(id => this.engine.view(this.engine.require(id))), relatedCount: related.size, requiresExplicitDecision: !event.decision && !event.owners.length }
    }
    if (name === 'thread_get') {
      const thread = this.require<Thread>('thread', params.threadId)
      const events = this.store.entities<TaskEvent>('event').filter(event => event.threadIds.includes(thread.id))
      return { thread, events: events.slice(params.cursor, params.cursor + params.limit), nextCursor: params.cursor + params.limit < events.length ? params.cursor + params.limit : null }
    }
    if (name === 'thread_list' || name === 'plan_list') {
      const rows = this.store.entities<Thread | Plan>(name === 'thread_list' ? 'thread' : 'plan')
      return { items: rows.slice(params.cursor, params.cursor + params.limit), nextCursor: params.cursor + params.limit < rows.length ? params.cursor + params.limit : null }
    }
    return this.store.once(this.engine.operatorId, name, params.requestId, params, () => {
      if (name === 'thread_create') {
        const thread: Thread = { id: randomUUID(), title: params.title, revision: 1, correlated: [], subscriptions: [] }
        this.store.saveEntity('thread', thread.id, thread); this.store.audit(thread.id, 'thread.created', {})
        return { thread }
      }
      if (name === 'thread_subscribe') {
        const thread = this.require<Thread>('thread', params.threadId), ticket = this.engine.require(params.ticketId)
        this.check(thread.revision, params.expectedRevision)
        const prior = thread.subscriptions.find(entry => entry.ticketId === ticket.id)
        requireCondition(!prior?.origin || params.mode === 'owning', 'FORBIDDEN', 'Origin subscription cannot be removed or downgraded')
        if (params.mode === 'remove') { thread.subscriptions = thread.subscriptions.filter(entry => entry.ticketId !== ticket.id); this.save('thread', thread, 'thread.unsubscribed') }
        else {
          if (prior) prior.mode = params.mode
          this.subscribe(thread, ticket.id, params.mode)
        }
        return { thread }
      }
      if (name === 'thread_unrelated') {
        const thread = this.require<Thread>('thread', params.threadId), ticket = this.engine.require(params.ticketId)
        this.check(thread.revision, params.expectedRevision); this.check(ticket.revision, params.expectedTicketRevision)
        const subscription = thread.subscriptions.find(entry => entry.ticketId === ticket.id)
        requireCondition(subscription && !subscription.origin, 'FORBIDDEN', 'Only a non-origin subscription may be marked unrelated')
        const events = this.store.entities<TaskEvent>('event').filter(event => event.threadIds.includes(thread.id) && event.owners.includes(ticket.id))
        for (const event of events) this.call('task_handback', { ticketId: ticket.id, expectedRevision: this.engine.require(ticket.id).revision, eventId: event.id, reason: params.reason, requestId: randomUUID() })
        thread.subscriptions = thread.subscriptions.filter(entry => entry.ticketId !== ticket.id)
        this.save('thread', thread, 'thread.unrelated')
        this.store.audit(ticket.id, 'thread.unrelated', { threadId: thread.id, reason: params.reason, returned: events.map(event => event.id) })
        return { thread, returned: events.map(event => event.id) }
      }
      if (name === 'event_record') {
        const threads = [...new Set<string>(params.threadIds)].map(id => this.require<Thread>('thread', id))
        const event: TaskEvent = { id: randomUUID(), threadIds: threads.map(thread => thread.id), text: params.text, source: params.source, createdAt: now(), delivered: [], owners: [], returned: [] }
        const subscriptions = new Map<string, boolean>()
        for (const thread of threads) {
          thread.correlated = [...new Set([...thread.correlated, ...event.threadIds.filter(id => id !== thread.id)])]
          this.save('thread', thread, 'thread.correlated')
          for (const entry of thread.subscriptions) subscriptions.set(entry.ticketId, (subscriptions.get(entry.ticketId) ?? true) && entry.mode === 'context')
        }
        for (const [ticketId, contextOnly] of subscriptions) this.deliver(event, this.engine.require(ticketId), contextOnly)
        this.store.saveEntity('event', event.id, event); this.store.audit(event.id, 'event.recorded', { delivered: event.delivered })
        return { event }
      }
      if (name === 'task_route') {
        return { results: params.items.map((item: any) => {
          try { return this.store.atomic(() => this.route(item, params.requestId)) }
          catch (error) {
            if (!(error instanceof DomainError)) throw error
            this.store.audit(item.eventId, 'route.refused', { kind: item.kind, code: error.code })
            return { eventId: item.eventId, kind: 'refused', code: error.code, reason: error.message }
          }
        }) }
      }
      if (name === 'task_handback') {
        const ticket = this.engine.require(params.ticketId), event = this.require<TaskEvent>('event', params.eventId)
        this.check(ticket.revision, params.expectedRevision)
        requireCondition(event.owners.includes(ticket.id) && !event.returned.includes(ticket.id), 'FORBIDDEN', 'Task does not own this event or already returned it')
        requireCondition(event.decision?.kind !== 'accept' || event.decision.ticketId !== ticket.id, 'FORBIDDEN', 'Original task scope cannot be returned as a follow-up; stop the task explicitly')
        requireCondition(latestAssignment(ticket)?.state !== 'running' && !ticket.reconciliation, 'INVALID_STATE', 'Wait for execution cleanup before returning an input')
        for (const entry of ticket.inputs) if (entry.eventId === event.id) {
          requireCondition(entry.state !== 'sending' && entry.state !== 'accepted', 'RECONCILIATION_REQUIRED', 'Input delivery is not settled')
          entry.returned = true
          if (entry.state === 'pending') entry.state = 'settled'
        }
        event.owners = event.owners.filter(id => id !== ticket.id); event.returned.push(ticket.id)
        const assignment = latestAssignment(ticket)
        if (assignment?.state === 'pending' && assignment.generation > 1 && !ticket.inputs.some(entry => entry.state === 'pending' && !entry.contextOnly && !entry.returned)) {
          assignment.state = 'ended'; assignment.endedAt = now()
          for (const effect of this.store.effects('pending')) if (effect.ticketId === ticket.id && effect.key === assignment.id) this.store.saveEffect({ ...effect, state: 'done' })
        }
        if (!event.owners.length) delete event.decision
        this.store.saveEntity('event', event.id, event)
        this.engine.save(ticket, 'event.returned', { eventId: event.id, reason: params.reason })
        return { event, queued: !event.owners.length }
      }
      if (name === 'plan_create') {
        validateGraph(params.tasks.map((task: any) => task.key), params.dependencies, params.integrationKey)
        requireCondition(Date.parse(params.expiresAt) > Date.now(), 'INVALID_STATE', 'Plan authorization must expire in the future')
        const planId = randomUUID(), mapping = new Map<string, string>()
        for (const task of params.tasks) {
          const { ticket } = this.engine.call('task_create', { repositoryId: params.repositoryId, title: task.title, request: task.request, requestId: randomUUID() }) as { ticket: Ticket }
          ticket.planId = planId; ticket.priority = task.priority; ticket.resources = [...new Set<string>(task.resources)]; ticket.reviewRequired = task.reviewRequired
          this.store.save(ticket); mapping.set(task.key, ticket.id)
        }
        const plan: Plan = { id: planId, title: params.title, revision: 1, version: 1, ticketIds: [...mapping.values()], dependencies: params.dependencies.map((dependency: Dependency) => ({ ...dependency, before: mapping.get(dependency.before)!, after: mapping.get(dependency.after)! })), integrationId: mapping.get(params.integrationKey)!, paused: false, held: false, heldTicketIds: [], maxAttempts: params.maxAttempts, expiresAt: params.expiresAt }
        plan.workflow = params.workflow
        if (params.workspace) {
          requireCondition(params.workspace.repositoryId === params.repositoryId, 'WORKSPACE_REPOSITORY_MISMATCH', 'Workspace must use the registered plan repository')
          plan.workspace = workspaceBinding(params.workspace, randomUUID())
          for (const id of plan.ticketIds) { const ticket = this.engine.require(id); ticket.workspaceBinding = plan.workspace; this.store.save(ticket) }
        }
        this.store.saveEntity('plan', plan.id, plan); this.store.audit(plan.id, 'plan.created', { mapping: Object.fromEntries(mapping) })
        return { ...this.planView(plan), mapping: Object.fromEntries(mapping) }
      }
      const plan = this.require<Plan>('plan', params.planId)
      this.check(plan.revision, params.expectedRevision)
      requireCondition(!plan.completed, 'INVALID_STATE', 'Plan is completed')
      if (name === 'plan_update') {
        requireCondition(plan.ticketIds.every(id => { const ticket = this.engine.require(id); return !ticket.result && ticket.assignments.every(assignment => !assignment.startedAt) && !ticket.reconciliation && !this.store.effects().some(effect => effect.ticketId === id && effect.kind !== 'launch' && effect.state !== 'done') }), 'INVALID_STATE', 'An executed plan cannot be edited in place')
        validateGraph(plan.ticketIds, params.dependencies, plan.integrationId)
        requireCondition(Date.parse(params.expiresAt) > Date.now(), 'INVALID_STATE', 'Expiry must be in the future')
        requireCondition(new Set(params.tasks.map((entry: any) => entry.ticketId)).size === params.tasks.length && params.tasks.every((entry: any) => plan.ticketIds.includes(entry.ticketId)), 'INVALID_GRAPH', 'Configuration references duplicate or foreign tasks')
        for (const task of params.tasks) { const ticket = this.engine.require(task.ticketId); ticket.priority = task.priority; ticket.resources = [...new Set<string>(task.resources)]; this.engine.save(ticket, 'task.constraints_updated') }
        plan.dependencies = params.dependencies; plan.maxAttempts = params.maxAttempts; plan.expiresAt = params.expiresAt; plan.version++; delete plan.grant
        for (const approval of this.store.approvals(plan.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
        this.save('plan', plan, 'plan.updated')
      } else if (name === 'plan_start') {
        requireCondition(Date.parse(plan.expiresAt) > Date.now(), 'INVALID_STATE', 'Plan expired')
        requireCondition(!this.store.approvals(plan.id).some(approval => approval.status === 'pending'), 'INVALID_STATE', 'Resolve pending plan approval first')
        this.save('plan', plan, 'plan.authorization_requested')
        const spec = this.spec(plan)
        const approval: Approval = { id: randomUUID(), ticketId: plan.id, kind: 'plan', status: 'pending', revision: plan.revision, createdAt: now(), expiresAt: new Date(Math.min(Date.parse(plan.expiresAt), Date.now() + 900_000)).toISOString(), details: { spec, fingerprint: fingerprint(spec) } }
        this.store.saveApproval(approval)
      } else if (name === 'plan_pause') { plan.paused = params.paused; this.save('plan', plan, 'plan.pause_changed') }
      else if (name === 'plan_stop') {
        plan.held = true; delete plan.grant
        for (const id of plan.ticketIds) {
          const ticket = this.engine.require(id)
          if (ticket.ended === 'completed') continue
          if (!ticket.mandate.humanHold) plan.heldTicketIds.push(id)
          this.engine.call('task_stop', { ticketId: id, expectedRevision: ticket.revision, reason: params.reason, requestId: randomUUID() })
        }
        plan.heldTicketIds = [...new Set(plan.heldTicketIds)]
        this.save('plan', plan, 'plan.stopped')
      }
      return this.planView(plan)
    })
  }
  private route(item: { eventId: string; kind: 'accept' | 'attach' | 'ignore' | 'stop'; ticketId?: string; expectedRevision?: number; title?: string; reason: string }, requestId: string) {
    const event = this.require<TaskEvent>('event', item.eventId)
    requireCondition(!event.decision && (item.kind === 'stop' || !event.owners.length), 'INVALID_STATE', 'Event already decided or owned by a task')
    let ticket: Ticket | undefined
    if (item.kind === 'accept') {
      requireCondition(item.title, 'INVALID_REQUEST', 'New tasks need a title')
      ticket = (this.engine.call('task_create', { repositoryId: this.store.repository()!.id, title: item.title, request: event.text, requestId: randomUUID() }) as { ticket: Ticket }).ticket
      ticket.inputs[0]!.eventId = event.id; ticket.inputs[0]!.source = event.source
      this.store.save(ticket); event.delivered.push(ticket.id); event.owners.push(ticket.id)
    } else if (item.kind === 'attach' || item.kind === 'stop') {
      requireCondition(item.ticketId && item.expectedRevision, 'INVALID_REQUEST', 'An explicit task and revision are required')
      ticket = this.engine.require(item.ticketId); this.check(ticket.revision, item.expectedRevision)
      requireCondition(!event.returned.includes(ticket.id), 'INVALID_STATE', 'Task already returned this event')
      if (item.kind === 'stop') this.engine.call('task_stop', { ticketId: ticket.id, expectedRevision: ticket.revision, reason: item.reason, requestId: randomUUID() })
      else {
        requireCondition(!ticket.ended && !ticket.mandate.humanHold && !ticket.stopping, 'INVALID_STATE', 'Explicit resume is required for an ended or held task')
        this.deliver(event, ticket, false)
        const existing = ticket.inputs.find(entry => entry.eventId === event.id)
        if (existing?.contextOnly) {
          existing.contextOnly = false
          const ticketId = ticket.id
          if (event.source === 'manual' && ticket.mandate.executionGranted && !ticket.reconciliation && !ticket.failure && !ticket.report?.question && !['blocked', 'failed'].includes(ticket.report?.state ?? '') && !this.store.effects().some(effect => effect.ticketId === ticketId && effect.kind === 'publish' && effect.state !== 'done')) this.engine.queue(ticket)
          this.engine.save(ticket, 'event.attached', { eventId: event.id })
        }
        if (!event.owners.includes(ticket.id)) event.owners.push(ticket.id)
      }
    }
    if (ticket && (item.kind === 'accept' || item.kind === 'attach')) for (const id of event.threadIds) this.subscribe(this.require<Thread>('thread', id), ticket.id, 'owning', item.kind === 'accept')
    event.decision = { kind: item.kind, reason: item.reason, ...(ticket ? { ticketId: ticket.id } : {}) }
    this.store.saveEntity('event', event.id, event); this.store.audit(event.id, 'route.decided', { ...event.decision, requestId })
    return { eventId: event.id, ...event.decision }
  }
  approve(approval: Approval, accept: boolean, expectedFingerprint?: string): Approval {
    const plan = this.require<Plan>('plan', approval.ticketId)
    if (accept) {
      this.check(plan.revision, approval.revision)
      requireCondition(expectedFingerprint === approval.details.fingerprint && expectedFingerprint === fingerprint(this.spec(plan)), 'REVISION_CONFLICT', 'Displayed plan changed; review a new approval')
      requireCondition(Date.parse(plan.expiresAt) > Date.now(), 'INVALID_STATE', 'Plan expired')
      requireCondition(plan.ticketIds.every(id => { const ticket = this.engine.require(id); return !ticket.reconciliation && !ticket.stopping }), 'RECONCILIATION_REQUIRED', 'Wait for stop cleanup and reconcile uncertain tasks')
      plan.grant = { version: plan.version, fingerprint: expectedFingerprint }; plan.held = false
      this.store.saveEntity('plan', plan.id, plan)
      for (const id of plan.ticketIds) {
        const ticket = this.engine.require(id)
        if (plan.heldTicketIds.includes(id)) { ticket.mandate.humanHold = false; if (ticket.ended === 'stopped') delete ticket.ended }
        if (!ticket.ended && !ticket.mandate.humanHold) {
          ticket.mandate.executionGranted = true
          const migratedBudgetExhausted = ticket.workspaceBinding && ticket.restartThread && latestAssignment(ticket)?.state === 'ended' && latestAssignment(ticket)!.generation >= plan.maxAttempts
          if (!ticket.report && !ticket.failure && !migratedBudgetExhausted) this.engine.queue(ticket)
          this.engine.save(ticket, 'plan.execution_granted', { planId: plan.id, version: plan.version })
        }
      }
      plan.heldTicketIds = []
    }
    this.save('plan', plan, 'plan.authorization_decided')
    approval.status = accept ? 'accepted' : 'declined'; this.store.saveApproval(approval)
    return approval
  }
  manualStop(ticket: Ticket): void {
    if (!ticket.planId) return
    const plan = this.require<Plan>('plan', ticket.planId)
    if (plan.heldTicketIds.includes(ticket.id)) { plan.heldTicketIds = plan.heldTicketIds.filter(id => id !== ticket.id); this.save('plan', plan, 'plan.individual_hold') }
  }
  acceptResult(ticketId: string, expectedRevision: number, kind: 'artifact' | 'code', content: string, sha?: string, acceptedBy: 'human' | 'coordinator' = 'human'): AcceptedResult {
    return this.store.atomic(() => {
      const ticket = this.engine.require(ticketId)
      this.check(ticket.revision, expectedRevision)
      requireCondition(!ticket.result && !ticket.mandate.humanHold && !ticket.stopping && !ticket.reconciliation && ticket.report?.state === 'ready' && !ticket.report.question && latestAssignment(ticket)?.state === 'ended' && validInputs(this.store, ticket), 'INVALID_STATE', 'Only current, ready results can be accepted once')
      requireCondition(ticket.inputs.every(entry => entry.state === 'settled') && !this.store.effects().some(effect => effect.ticketId === ticket.id && effect.state !== 'done') && !this.store.approvals(ticket.id).some(approval => approval.status === 'pending'), 'INVALID_STATE', 'Settle inputs, operations and approvals before acceptance')
      requireCondition(kind === 'artifact' || (ticket.mergeRequest?.state === 'merged' && sha === ticket.mergeRequest.mergedSha && /^[a-f0-9]{40,64}$/.test(sha ?? '')), 'INVALID_STATE', 'Code acceptance requires the bound MR merge commit')
      if (ticket.planId) {
        const plan = this.require<Plan>('plan', ticket.planId)
        requireCondition(!plan.held, 'INVALID_STATE', 'Plan is held')
        requireCondition(plan.dependencies.filter(dependency => dependency.before === ticketId).every(dependency => dependency.condition === kind), 'INVALID_STATE', 'Result kind must satisfy the declared outgoing dependencies')
      }
      const result: AcceptedResult = { id: randomUUID(), ticketId, kind, content, hash: fingerprint({ kind, content, sha }), ...(sha ? { sha } : {}), acceptedAt: now(), operatorId: acceptedBy === 'coordinator' ? 'coordinator' : this.engine.operatorId, acceptedBy }
      ticket.result = result; ticket.ended = 'completed'
      this.engine.save(ticket, 'result.accepted', result)
      return result
    })
  }
  advanceHandoffs(): number {
    return this.store.atomic(() => {
      if (this.store.get('paused')) return 0
      let accepted = 0
      for (const plan of this.store.entities<Plan>('plan')) {
        if (!plan.workflow?.automaticHandoffs || plan.held || plan.paused || plan.completed || plan.grant?.version !== plan.version || Date.parse(plan.expiresAt) <= Date.now() || plan.grant.fingerprint !== fingerprint(this.spec(plan))) continue
        if (this.store.approvals(plan.id).some(approval => approval.status === 'pending')) continue
        for (const id of plan.ticketIds) {
          const ticket = this.engine.require(id)
          if (id === plan.integrationId || ticket.reviewRequired || ticket.result || ticket.ended || ticket.failure || ticket.mergeRequest || !ticket.mandate.executionGranted || ticket.mandate.humanHold || ticket.stopping || ticket.reconciliation || ticket.report?.state !== 'ready' || ticket.report.question || !ticket.report.checks.some(check => check.trim()) || latestAssignment(ticket)?.state !== 'ended' || !validInputs(this.store, ticket)) continue
          const outgoing = plan.dependencies.filter(edge => edge.before === id)
          if (plan.dependencies.filter(edge => edge.after === id).some(edge => { const upstream = this.engine.require(edge.before); return upstream.mandate.humanHold || upstream.reconciliation || upstream.stopping })) continue
          if (!outgoing.length || outgoing.some(edge => edge.condition !== 'artifact') || ticket.inputs.some(entry => entry.state !== 'settled') || this.store.effects().some(effect => effect.ticketId === id && effect.state !== 'done') || this.store.approvals(id).some(approval => approval.status === 'pending')) continue
          const content = JSON.stringify({ summary: ticket.report.summary, checks: ticket.report.checks, notice: 'Automatic artifact handoff, not independent human verification.' })
          if (content.length > 30_000) continue
          this.acceptResult(id, ticket.revision, 'artifact', content, undefined, 'coordinator')
          this.store.audit(id, 'workflow.artifact_handed_off', { planId: plan.id, version: plan.version })
          accepted++
        }
      }
      return accepted
    })
  }
  canComplete(plan: Plan): boolean {
    return !plan.held && !plan.completed && plan.ticketIds.every(id => {
      const ticket = this.engine.require(id)
      return !!ticket.result && !ticket.mandate.humanHold && !ticket.reconciliation && !ticket.stopping && ticket.inputs.every(entry => entry.state === 'settled') && validInputs(this.store, ticket) && !this.store.effects().some(effect => effect.ticketId === id && effect.state !== 'done') && !this.store.approvals(id).some(approval => approval.status === 'pending')
    }) && !this.store.approvals(plan.id).some(approval => approval.status === 'pending')
  }
  complete(planId: string, expectedRevision: number): void {
    this.store.atomic(() => {
      const plan = this.require<Plan>('plan', planId)
      this.check(plan.revision, expectedRevision)
      requireCondition(this.canComplete(plan), 'INVALID_STATE', 'Every required task including integration must have a settled, accepted result')
      plan.completed = true; this.save('plan', plan, 'plan.completed')
    })
  }
}
