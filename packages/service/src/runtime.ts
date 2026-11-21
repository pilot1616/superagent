import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DomainError, latestAssignment, requireCondition, type Assignment, type Plan, type Ticket } from '../../core/src/model.js'
import { candidates } from '../../core/src/scheduler.js'
import type { ExecutionPermit, RuntimeGate } from '../../core/src/ports.js'
import { Store } from '../../storage/src/store.js'
import { evaluateRuntime, runtimeReadiness } from '../../executor-codex/src/acceptance.js'
import { credentialStamp, inspectRuntime, launchStamp, publicInspection, sha256, runtimeCodeStamp } from '../../executor-codex/src/inspection.js'
import { canonicalJson, loadProfile } from '../../executor-codex/src/profile.js'
import { enablementSchema, inspectionSchema, requiredCapabilities, runtimeStateSchema, verificationSchema, type RuntimeEnablement, type RuntimeInspection, type RuntimeSnapshot, type RuntimeState, type RuntimeVerification } from '../../executor-codex/src/contracts.js'
import type { ServiceConfig } from './config.js'
import { processSnapshot, type ProcessIdentity } from '../../executor-codex/src/processes.js'

const operationSchema = z.object({ requestId: z.string().min(1).max(150), expectedRevision: z.number().int().positive(), repositoryId: z.string().min(1).max(1024), confirmation: z.string().min(1).max(1024) }).strict()
export const enableRequestSchema = operationSchema.extend({ reviewId: z.string().uuid(), mode: z.literal('restricted_local'), verificationId: z.string().uuid().optional(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(1000) }).strict()
export const disableRequestSchema = operationSchema.extend({ mode: z.enum(['drain', 'stop']), reason: z.string().trim().min(1).max(1000), reviewId: z.string().uuid().optional() }).strict()
export const previewRequestSchema = z.object({ expectedRevision: z.number().int().positive(), repositoryId: z.string().min(1).max(1024) }).strict()
type Review = { id: string; kind: 'enable' | 'disable' | 'verify'; revision: number; fingerprint: string; verificationId?: string; expiresAt: number; consumed?: boolean; detail?: unknown; contextHash: string }

export class RuntimeController implements RuntimeGate {
  readonly daemonEpoch = randomUUID()
  onSafetyInvalidation?: (reasonCode: string) => void
  private checking?: Promise<ReturnType<RuntimeController['status']>>
  private permits = new WeakMap<ExecutionPermit, { expiresAt: number; scope: string }>()
  private stamp?: string
  private loadedBuildHash?: string
  private readonly loadedCodeStamp = runtimeCodeStamp()
  constructor(readonly store: Store, readonly stateDir: string, readonly config: ServiceConfig, private inspect = inspectRuntime) {
    const repositoryId = store.repository()!.id
    const previous = store.entity<RuntimeState>('runtime_state', repositoryId)
    let state = previous ? runtimeStateSchema.parse(previous) : runtimeStateSchema.parse({ repositoryId, revision: 1, fence: 0, mode: 'restricted_local', policyVersion: 1, updatedAt: new Date().toISOString() })
    if (previous) state = { ...state, revision: state.revision + 1, fence: state.fence + 1, inspectionId: undefined, updatedAt: new Date().toISOString() }
    store.saveEntity('runtime_state', repositoryId, state)
    this.clearReviews()
    if (state.verificationRunId) {
      const run = store.entity<RuntimeVerification>('runtime_verification', state.verificationRunId)
      if (run && ['prepared', 'running'].includes(run.state)) store.saveEntity('runtime_verification', run.id, { ...run, revision: run.revision + 1, state: 'cleanup_uncertain', reasonCode: 'VERIFICATION_INTERRUPTED', finishedAt: new Date().toISOString() })
      this.quarantine('VERIFICATION_INTERRUPTED', [])
    }
  }
  state(): RuntimeState { return runtimeStateSchema.parse(this.store.entity('runtime_state', this.store.repository()!.id)) }
  snapshot(): RuntimeSnapshot {
    const state = this.state()
    const verification = state.verificationId ? verificationSchema.parse(this.store.entity('runtime_verification', state.verificationId)) : undefined
    let verificationEvidenceValid = false
    if (verification) { try { this.checkEvidence(verification); verificationEvidenceValid = true } catch {} }
    return { state, daemonEpoch: this.daemonEpoch, inspection: state.inspectionId ? inspectionSchema.parse(this.store.entity('runtime_inspection', state.inspectionId)) : undefined, verification, verificationEvidenceValid, enablement: state.enablementId ? enablementSchema.parse(this.store.entity('runtime_enablement', state.enablementId)) : undefined }
  }
  status() {
    const snapshot = this.snapshot()
    const runtime = evaluateRuntime(snapshot)
    return { ...runtime, inspection: publicInspection(runtime.inspection), runtimeReadiness: runtimeReadiness(snapshot), quarantine: snapshot.state.quarantine, inspectionCommand: 'superagent-local runtime check --state <project state>', loginInstructions: '在可信终端运行 CODEX_HOME="<STATE>/worker-home/.codex" codex login --device-auth；不要把凭据发给模型。' }
  }
  private update(change: Partial<RuntimeState>, event: string, detail: unknown, fence = false) {
    const state = this.state()
    const next = runtimeStateSchema.parse({ ...state, ...change, revision: state.revision + 1, fence: state.fence + Number(fence), updatedAt: new Date().toISOString() })
    this.store.saveEntity('runtime_state', state.repositoryId, next)
    this.store.audit(state.repositoryId, event, detail)
    return next
  }
  private requireRevision(revision: number, repositoryId: string, confirmation?: string) {
    const state = this.state()
    requireCondition(repositoryId === state.repositoryId && (confirmation === undefined || confirmation === repositoryId), 'FORBIDDEN', 'Confirm the exact current project')
    requireCondition(revision === state.revision, 'REVISION_CONFLICT', 'Runtime state changed; review it again', 409)
    return state
  }
  invalidate(reasonCode: string) {
    this.store.atomic(() => {
      const snapshot = this.snapshot()
      if (snapshot.enablement?.status === 'active') this.store.saveEntity('runtime_enablement', snapshot.enablement.id, { ...snapshot.enablement, status: 'invalidated' })
      this.update({ enablementId: undefined }, 'runtime.invalidated', { reasonCode }, true)
      if (reasonCode === 'RUNTIME_FINGERPRINT_CHANGED') this.onSafetyInvalidation?.(reasonCode)
    })
  }
  check(): Promise<ReturnType<RuntimeController['status']>> {
    return this.checking ??= this.inspectCurrent().finally(() => { this.checking = undefined })
  }
  recheck(): void {
    this.store.atomic(() => this.update({ inspectionFailure: { reasonCode: 'RUNTIME_INSPECTION_STALE', at: new Date().toISOString() } }, 'runtime.recheck_requested', { reason: 'Settled pre-turn preparation failure' }, true))
    void this.check()
  }
  private async inspectCurrent() {
    try {
      requireCondition(this.loadedCodeStamp === runtimeCodeStamp(), 'RUNTIME_RESTART_REQUIRED', 'Runtime files changed after daemon startup; restart before inspection', 409)
      const profile = await loadProfile(this.stateDir)
      const stamp = credentialStamp(profile)
      const prior = this.store.get<{ stamp: string; generation: number }>('runtime:auth-generation')
      const generation = prior ? prior.generation + Number(prior.stamp !== stamp) : 1
      this.store.set('runtime:auth-generation', { stamp, generation })
      const inspection = await this.inspect(this.stateDir, this.state().repositoryId, generation, this.config.runtime.inspectionTtlSeconds)
      if (!this.loadedBuildHash) this.loadedBuildHash = inspection.runtimeBuildHash
      requireCondition(this.loadedBuildHash === inspection.runtimeBuildHash, 'RUNTIME_RESTART_REQUIRED', 'Runtime build changed on disk; restart and re-inspect before using the new implementation', 409)
      const currentStamp = launchStamp(this.stateDir, inspection.executable.realpath)
      requireCondition(credentialStamp(profile) === stamp, 'RUNTIME_FINGERPRINT_CHANGED', 'Authentication changed during inspection')
      this.store.atomic(() => {
        const previous = this.snapshot().inspection
        this.store.saveEntity('runtime_inspection', inspection.id, inspectionSchema.parse(inspection))
        if (previous?.fingerprint && previous.fingerprint !== inspection.fingerprint) this.invalidate('RUNTIME_FINGERPRINT_CHANGED')
        const same = previous?.fingerprint === inspection.fingerprint && JSON.stringify(previous.checks) === JSON.stringify(inspection.checks) && previous.auth.status === inspection.auth.status
        if (same) this.store.saveEntity('runtime_state', this.state().repositoryId, { ...this.state(), inspectionId: inspection.id, inspectionFailure: undefined })
        else this.update({ inspectionId: inspection.id, inspectionFailure: undefined }, 'runtime.inspected', { inspectionId: inspection.id, checks: inspection.checks })
        this.stamp = currentStamp
        const snapshot = this.snapshot()
        const enablement = snapshot.enablement
        if (enablement?.status === 'active' && enablement.daemonEpoch !== this.daemonEpoch) {
          const restored = { ...enablement, daemonEpoch: this.daemonEpoch }
          const uncertain = this.store.effects('uncertain').length > 0 || this.store.tickets().some(ticket => ticket.reconciliation || latestAssignment(ticket)?.state === 'running')
          if (!uncertain && evaluateRuntime({ ...snapshot, enablement: restored }).canDispatch) {
            this.store.saveEntity('runtime_enablement', restored.id, restored)
            this.store.audit(snapshot.state.repositoryId, 'runtime.authorization_restored', { enablementId: restored.id, expiresAt: restored.expiresAt })
          } else if (enablement.fingerprint !== inspection.fingerprint) this.invalidate('RUNTIME_FINGERPRINT_CHANGED')
        }
      })
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'RUNTIME_UNSUPPORTED'
      this.store.atomic(() => {
        if (this.state().inspectionFailure?.reasonCode !== code || this.state().inspectionId) { this.invalidate(code); this.update({ inspectionId: undefined, inspectionFailure: { reasonCode: code, at: new Date().toISOString() } }, 'runtime.inspection_failed', { reasonCode: code }) }
      })
    }
    return this.status()
  }
  blocker() {
    const status = evaluateRuntime(this.snapshot())
    return status.canDispatch ? undefined : { reason: `Worker: ${status.reasonCodes[0]}`, reasonCodes: status.reasonCodes }
  }
  bind(ticket: Ticket, assignment: Assignment) {
    const snapshot = this.snapshot()
    const status = evaluateRuntime(snapshot)
    requireCondition(ticket.repositoryId === snapshot.state.repositoryId, 'FORBIDDEN', 'Execution belongs to another project')
    requireCondition(status.canDispatch, status.reasonCodes[0] ?? 'RUNTIME_ENABLEMENT_REQUIRED', 'Runtime is not enabled for dispatch', 409)
    Object.assign(assignment, { runtimeFingerprint: status.fingerprint, runtimeFence: status.fence, enablementId: snapshot.enablement!.id, launchPhase: 'claimed' })
  }
  permit(ticket: Ticket): ExecutionPermit {
    const assignment = latestAssignment(ticket)!
    requireCondition(assignment?.state === 'running' && ticket.repositoryId === this.state().repositoryId, 'PREPARATION_CANCELLED', 'Only a claimed assignment in this project can receive an execution permit', 409)
    const permit = Object.freeze({ assignmentId: assignment.id, ticketId: ticket.id, fingerprint: assignment.runtimeFingerprint!, fence: assignment.runtimeFence!, enablementId: assignment.enablementId!, executable: this.snapshot().inspection!.executable.realpath })
    this.permits.set(permit, { expiresAt: Date.now() + 60_000, scope: ticket.scope })
    this.validate(permit)
    return permit
  }
  validate(permit: ExecutionPermit) {
    const issued = this.permits.get(permit)
    const snapshot = this.snapshot()
    const status = evaluateRuntime(snapshot)
    const ticket = this.store.ticket(permit.ticketId)
    const assignment = ticket && latestAssignment(ticket)
    let unchanged = false
    try { unchanged = this.loadedCodeStamp === runtimeCodeStamp() && !!snapshot.inspection && launchStamp(this.stateDir, snapshot.inspection.executable.realpath) === this.stamp } catch {}
    if (!unchanged && snapshot.enablement?.status === 'active') this.store.atomic(() => this.invalidate('RUNTIME_FINGERPRINT_CHANGED'))
    requireCondition(issued && issued.expiresAt > Date.now() && unchanged && status.canDispatch && status.fence === permit.fence && status.fingerprint === permit.fingerprint && snapshot.enablement?.id === permit.enablementId, 'RUNTIME_FINGERPRINT_CHANGED', 'Execution permit expired or environment changed', 409)
    requireCondition(ticket && assignment?.id === permit.assignmentId && assignment.state === 'running' && !ticket.mandate.humanHold && !ticket.stopping && !ticket.reconciliation && !ticket.ended && ticket.scope === issued.scope, 'PREPARATION_CANCELLED', 'Task stopped or changed before turn delivery', 409)
  }
  quarantine(reasonCode: string, assignmentIds: string[]) {
    this.store.atomic(() => {
      this.invalidate(reasonCode)
      const previous = this.state().quarantine
      this.update({ quarantine: { reasonCode, since: previous?.since ?? new Date().toISOString(), assignmentIds: [...new Set([...(previous?.assignmentIds ?? []), ...assignmentIds])] } }, 'runtime.quarantined', { reasonCode, assignmentIds }, true)
      this.onSafetyInvalidation?.(reasonCode)
    })
  }
  clearReviews() {
    for (const review of this.store.entities<Review>('runtime_review')) if (!review.consumed) this.store.saveEntity('runtime_review', review.id, { ...review, consumed: true })
  }
  beginVerification(verification: RuntimeVerification) {
    const value = verificationSchema.parse(verification)
    requireCondition(value.repositoryId === this.state().repositoryId && !this.state().verificationRunId && !this.state().quarantine, 'INVALID_STATE', 'Runtime cannot begin verification', 409)
    this.invalidate('RUNTIME_VERIFICATION_RUNNING')
    this.store.saveEntity('runtime_verification', value.id, value)
    this.update({ verificationRunId: value.id, verificationId: value.id }, 'runtime.verification_started', { verificationId: value.id, limits: value.limits }, true)
  }
  finishVerification(verification: RuntimeVerification) {
    const value = verificationSchema.parse(verification)
    this.store.atomic(() => {
      requireCondition(this.state().verificationRunId === value.id, 'INVALID_STATE', 'Verification is not owned by this runtime', 409)
      this.store.saveEntity('runtime_verification', value.id, value)
      if (['prepared', 'running'].includes(value.state)) return
      this.update({ verificationRunId: undefined }, 'runtime.verification_finished', { verificationId: value.id, state: value.state, reasonCode: value.reasonCode })
      if (value.state === 'cleanup_uncertain') this.quarantine('PROCESS_CLEANUP_UNCERTAIN', [])
    })
  }
  async reconcile(raw: unknown) {
    const params = operationSchema.extend({ reason: z.string().trim().min(10).max(1000) }).strict().parse(raw)
    const needsSnapshot = this.store.tickets().some(ticket => {
      const record = this.store.get<{ pid?: number; state: string }>(`process:${ticket.id}`)
      return record?.pid && record.state !== 'group-closed'
    }) || this.store.entities<{ state: string }>('runtime_verification_process').some(record => record.state !== 'group-closed')
    const snapshot = needsSnapshot ? await processSnapshot() : new Map<number, ProcessIdentity>()
    return this.store.once(this.config.operatorId, 'runtime-reconcile', params.requestId, params, () => {
      this.requireRevision(params.expectedRevision, params.repositoryId, params.confirmation)
      requireCondition(this.state().quarantine, 'INVALID_STATE', 'Runtime is not quarantined', 409)
      requireCondition(!this.store.tickets().some(ticket => ticket.reconciliation || ticket.stopping || latestAssignment(ticket)?.state === 'running') && !this.store.effects().some(effect => ['running', 'uncertain'].includes(effect.state)), 'RECONCILIATION_REQUIRED', 'Reconcile tasks and effects first', 409)
      for (const ticket of this.store.tickets()) {
        const record = this.store.get<{ pid?: number; state: string; observedDescendants?: ProcessIdentity[] }>(`process:${ticket.id}`)
        if (!record?.pid || record.state === 'group-closed') continue
        requireCondition(!record.observedDescendants?.some(identity => { const current = snapshot.get(identity.pid); return current && (current.start === identity.start || current.start === 'unavailable') }), 'RECONCILIATION_REQUIRED', 'A previously observed Worker process is still alive or inaccessible; inspect its exact identity', 409)
        let absent = false
        try { process.kill(-record.pid, 0) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        requireCondition(absent, 'RECONCILIATION_REQUIRED', 'A prior process group may still exist; never kill a reused PID blindly', 409)
      }
      for (const record of this.store.entities<{ pid: number; state: string; observed: ProcessIdentity[] }>('runtime_verification_process')) {
        if (record.state === 'group-closed') continue
        requireCondition(!record.observed.some(identity => { const current = snapshot.get(identity.pid); return current && (current.start === identity.start || current.start === 'unavailable') }), 'RECONCILIATION_REQUIRED', 'An observed verification process remains alive or inaccessible', 409)
        let absent = false
        try { process.kill(-record.pid, 0) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        requireCondition(absent, 'RECONCILIATION_REQUIRED', 'The interrupted verification process group still needs inspection', 409)
      }
      this.update({ quarantine: undefined, verificationRunId: undefined, verificationId: undefined, enablementId: undefined }, 'runtime.reconciled', { reason: params.reason, operatorId: this.config.operatorId }, true)
      return this.status()
    })
  }
  preview(kind: Review['kind'], raw: unknown, detail?: unknown) {
    const params = previewRequestSchema.parse(raw)
    this.requireRevision(params.expectedRevision, params.repositoryId)
    const status = this.status()
    requireCondition(status.fingerprint || kind === 'disable', 'RUNTIME_INSPECTION_STALE', 'Check the project environment first', 409)
    if (kind === 'enable') requireCondition(status.phase === 'ready', status.reasonCodes[0] ?? 'RUNTIME_UNSUPPORTED', 'Current runtime cannot be enabled', 409)
    const context = this.previewContext()
    const fingerprint = status.fingerprint ?? sha256(canonicalJson({ repositoryId: params.repositoryId, revision: status.revision, inspection: 'unavailable' }))
    const review: Review = { id: randomUUID(), kind, revision: status.revision, fingerprint, verificationId: status.verification?.id, expiresAt: Date.now() + 300_000, detail, contextHash: sha256(canonicalJson(context)) }
    this.store.saveEntity('runtime_review', review.id, review)
    return { reviewId: review.id, expectedRevision: review.revision, repositoryId: params.repositoryId, mode: 'restricted_local', expectedFingerprint: review.fingerprint, verificationId: review.verificationId, expiresAt: new Date(review.expiresAt).toISOString(), ...context, detail, verificationRequired: false, verificationPassed: status.verificationPassed, warningCodes: status.warningCodes, capabilities: status.verificationPassed ? [...requiredCapabilities] : [], unsupported: ['runtimeEscalation', 'toolNetworkGrant', 'gitlabPublication', 'hardTokenBudget'] }
  }
  private previewContext() {
    const queued = candidates(this.store, new Set(), new Set(), this.config.concurrency).map(effect => {
      const ticket = this.store.ticket(effect.ticketId)!
      const plan = ticket.planId ? this.store.entity<Plan>('plan', ticket.planId) : undefined
      return { id: ticket.id, title: ticket.title, revision: ticket.revision, scopeHash: sha256(ticket.scope), generation: latestAssignment(ticket)!.generation, planId: ticket.planId, maxAttempts: plan?.maxAttempts, expiresAt: plan?.expiresAt, resources: ticket.resources ?? [] }
    })
    const affectedTasks = this.store.tickets().filter(ticket => latestAssignment(ticket)?.state === 'running').map(ticket => ({ id: ticket.id, title: ticket.title, assignmentId: latestAssignment(ticket)!.id, revision: ticket.revision, humanHold: ticket.mandate.humanHold }))
    const agents = this.snapshot().inspection?.agents
    return { queued, affectedTasks, concurrency: this.config.concurrency, agents, maxAgentSessions: this.config.concurrency * (1 + (agents?.enabled ? agents.maxConcurrent : 0)), humanContinuationReserve: 1, authorizedPendingCount: this.store.tickets().filter(ticket => ticket.mandate.executionGranted && latestAssignment(ticket)?.state === 'pending' && !ticket.mandate.humanHold).length, paused: this.store.get('paused') ?? false }
  }
  consumeReview(id: string, kind: Review['kind'], expectedRevision: number, repositoryId: string) {
    this.requireRevision(expectedRevision, repositoryId)
    const review = this.store.entity<Review>('runtime_review', id)
    const fingerprint = this.status().fingerprint ?? (kind === 'disable' ? sha256(canonicalJson({ repositoryId, revision: expectedRevision, inspection: 'unavailable' })) : undefined)
    requireCondition(review && review.kind === kind && !review.consumed && review.expiresAt > Date.now() && review.revision === expectedRevision && review.fingerprint === fingerprint, 'RUNTIME_FINGERPRINT_CHANGED', 'Review expired, was consumed, or environment changed', 409)
    requireCondition(review.contextHash === sha256(canonicalJson(this.previewContext())), 'REVISION_CONFLICT', 'Queued tasks, budgets or affected executions changed; review them again', 409)
    this.store.saveEntity('runtime_review', id, { ...review, consumed: true })
    return review
  }
  private checkEvidence(verification: RuntimeVerification) {
    requireCondition(verification.evidence.length > 0 && requiredCapabilities.every(key => verification.capabilities[key]?.evidenceIds.every(id => verification.evidence.some(evidence => evidence.id === id))), 'RUNTIME_VERIFICATION_REQUIRED', 'Verification lacks evidence references', 409)
    for (const evidence of verification.evidence) {
      let matches = false
      try { matches = sha256(readFileSync(join(this.stateDir, 'runtime/evidence', verification.id, evidence.relativePath))) === evidence.sha256 } catch {}
      requireCondition(matches, 'RUNTIME_VERIFICATION_REQUIRED', 'Verification evidence is missing or changed', 409)
    }
  }
  enable(raw: unknown) {
    const params = enableRequestSchema.parse(raw)
    return this.store.once(this.config.operatorId, 'runtime-enable', params.requestId, params, () => {
      this.requireRevision(params.expectedRevision, params.repositoryId, params.confirmation)
      const snapshot = this.snapshot()
      const status = evaluateRuntime(snapshot)
      requireCondition(status.phase === 'ready', status.reasonCodes.find(code => code !== 'RUNTIME_ENABLEMENT_REQUIRED') ?? 'INVALID_STATE', 'Current runtime cannot be enabled', 409)
      requireCondition(params.expectedFingerprint === status.fingerprint && params.verificationId === snapshot.verification?.id, 'RUNTIME_FINGERPRINT_CHANGED', 'Runtime changed since review', 409)
      requireCondition(snapshot.inspection && launchStamp(this.stateDir, snapshot.inspection.executable.realpath) === this.stamp, 'RUNTIME_FINGERPRINT_CHANGED', 'Environment changed after review', 409)
      const review = this.consumeReview(params.reviewId, 'enable', params.expectedRevision, params.repositoryId)
      requireCondition(review.verificationId === params.verificationId, 'RUNTIME_FINGERPRINT_CHANGED', 'Verification changed since review', 409)
      const enablement: RuntimeEnablement = enablementSchema.parse({ id: randomUUID(), repositoryId: params.repositoryId, mode: params.mode, fingerprint: params.expectedFingerprint, verificationId: params.verificationId, daemonEpoch: this.daemonEpoch, status: 'active', capabilities: status.verificationPassed ? [...requiredCapabilities] : [], operatorId: this.config.operatorId, reason: params.reason, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.config.runtime.enablementMaxHours * 3600_000).toISOString() })
      this.store.saveEntity('runtime_enablement', enablement.id, enablement)
      this.update({ enablementId: enablement.id }, 'runtime.enabled', { enablementId: enablement.id, fingerprint: enablement.fingerprint, verificationRequired: false, warningCodes: status.warningCodes }, true)
      return { operationId: randomUUID(), enablementId: enablement.id, expiresAt: enablement.expiresAt, capabilities: enablement.capabilities, runtime: this.status() }
    })
  }
  enableForWorkflow(expectedRevision: number, expectedFingerprint: string, planId: string) {
    const status = this.status()
    requireCondition(status.revision === expectedRevision && status.fingerprint === expectedFingerprint, 'REVISION_CONFLICT', 'Runtime changed during goal preparation; confirm the goal again', 409)
    requireCondition(this.loadedCodeStamp === runtimeCodeStamp() && this.snapshot().inspection && launchStamp(this.stateDir, this.snapshot().inspection!.executable.realpath) === this.stamp, 'RUNTIME_FINGERPRINT_CHANGED', 'Runtime changed during goal preparation', 409)
    if (status.canDispatch) return
    const repositoryId = this.state().repositoryId
    const preview = this.preview('enable', { expectedRevision, repositoryId })
    this.enable({ requestId: randomUUID(), expectedRevision, repositoryId, confirmation: repositoryId, reviewId: preview.reviewId, mode: 'restricted_local', expectedFingerprint, verificationId: preview.verificationId, reason: `Restricted execution authorized with goal ${planId}` })
  }
  disable(raw: unknown) {
    const params = disableRequestSchema.parse(raw)
    return this.store.once(this.config.operatorId, 'runtime-disable', params.requestId, params, () => {
      this.requireRevision(params.expectedRevision, params.repositoryId, params.confirmation)
      if (params.mode === 'stop') { requireCondition(params.reviewId, 'APPROVAL_REQUIRED', 'Preview the affected running tasks before stopping'); this.consumeReview(params.reviewId, 'disable', params.expectedRevision, params.repositoryId) }
      const enablement = this.snapshot().enablement
      if (enablement) this.store.saveEntity('runtime_enablement', enablement.id, { ...enablement, status: 'disabled' })
      const affected = params.mode === 'stop' ? this.store.tickets().filter(ticket => latestAssignment(ticket)?.state === 'running' && !ticket.mandate.humanHold).map(ticket => ticket.id) : []
      const assignments = Object.fromEntries(affected.map(id => [id, latestAssignment(this.store.ticket(id)!)!.id]))
      this.update({ enablementId: undefined }, 'runtime.disabled', { mode: params.mode, reason: params.reason, affected }, true)
      return { operationId: randomUUID(), mode: params.mode, affected, assignments, runtime: this.status() }
    })
  }
}
