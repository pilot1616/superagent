import { Engine } from '../../core/src/engine.js'
import { latestAssignment, requireCondition, type Effect, type PublishPreview, type Ticket } from '../../core/src/model.js'
import type { Persistence } from '../../core/src/ports.js'
import { validateMergeRequest, type GitLabPort } from './api.js'
import { validInputs } from '../../core/src/scheduler.js'
import { previewWorkspace, commitPreview } from './workspace.js'

export class Delivery {
  constructor(private store: Persistence, private engine: Engine, private state: string, private gitlab: GitLabPort, private push: (ticket: Ticket, preview: PublishPreview, sha: string) => Promise<void>) {}
  async preview(approvalId: string, authorName: string, authorEmail: string): Promise<PublishPreview> {
    const approval = this.store.approval(approvalId)
    requireCondition(approval?.kind === 'publish', 'INVALID_STATE', 'A publication request is required')
    const ticket = this.engine.require(approval.ticketId)
    const preview = await previewWorkspace(this.store.repository()!, ticket, this.state, authorName, authorEmail)
    this.engine.attachPreview(approvalId, preview)
    return preview
  }
  async approve(approvalId: string, expectedFingerprint: string): Promise<void> {
    const approval = this.store.approval(approvalId)
    const approved = approval?.details.preview as PublishPreview | undefined
    requireCondition(approval && approved, 'APPROVAL_REQUIRED', 'Generate and inspect a publication preview first')
    requireCondition(expectedFingerprint && approved.fingerprint === expectedFingerprint, 'REVISION_CONFLICT', 'Displayed publication preview changed; inspect it again before approving')
    const current = await previewWorkspace(this.store.repository()!, this.engine.require(approval.ticketId), this.state, approved.authorName, approved.authorEmail)
    this.engine.authorizePublish(approvalId, current, expectedFingerprint)
  }
  async publish(effect: Effect): Promise<void> {
    const ticket = this.authorized(effect)
    const preview = effect.payload.preview as PublishPreview
    requireCondition(preview, 'INVALID_STATE', 'Publication preview is missing')
    const current = await previewWorkspace(this.store.repository()!, { ...ticket, revision: preview.revision }, this.state, preview.authorName, preview.authorEmail)
    requireCondition(current.fingerprint === preview.fingerprint, 'REVISION_CONFLICT', 'Publication contents changed after approval')
    this.authorized(effect)
    const previous = await this.gitlab.find(preview.repository, preview.branch)
    requireCondition(previous.length <= 1, 'RECONCILIATION_REQUIRED', 'Multiple MRs use this branch')
    if (previous[0]) {
      const mergeRequest = validateMergeRequest(previous[0], preview.repository, preview.branch, preview.baseRef)
      requireCondition(mergeRequest.state === 'open' && (!ticket.mergeRequest || mergeRequest.iid === ticket.mergeRequest.iid), 'RECONCILIATION_REQUIRED', 'Existing MR is closed or belongs to another binding')
    }
    this.checkpoint(effect, 'committing')
    const commit = await commitPreview(ticket, preview)
    this.store.atomic(() => {
      const persisted = this.store.effects().find(entry => entry.key === effect.key)!
      this.store.saveEffect({ ...persisted, payload: { ...persisted.payload, phase: 'committed', committedSha: commit } })
      this.store.audit(ticket.id, 'publish.commit_created', { sha: commit })
    })
    this.checkpoint(effect, 'pushing')
    await this.push(ticket, preview, commit)
    this.checkpoint(effect, 'pushed')
    this.checkpoint(effect, previous[0] ? 'reading-mr' : 'creating-mr')
    const record = previous[0] ? await this.gitlab.read(preview.repository, previous[0].iid) : await this.gitlab.create(preview.repository, { sourceBranch: preview.branch, targetBranch: preview.baseRef, title: preview.title, description: preview.body })
    const mergeRequest = validateMergeRequest(record, preview.repository, preview.branch, preview.baseRef)
    requireCondition(mergeRequest.headSha === commit, 'RECONCILIATION_REQUIRED', 'Remote MR head differs from the authorized commit')
    this.engine.syncMergeRequest(ticket.id, mergeRequest)
  }
  private authorized(effect: Effect): Ticket {
    const ticket = this.engine.require(effect.ticketId)
    requireCondition(validInputs(this.store, ticket), 'REVISION_CONFLICT', 'Dependency result snapshot changed before publication')
    const persisted = this.store.effects('running').find(entry => entry.key === effect.key)
    const preview = persisted?.payload.preview as PublishPreview | undefined
    const registered = this.store.repository()?.gitlab
    requireCondition(preview?.provider === 'gitlab' && registered && preview.repository?.url === registered.url && preview.repository.projectPath === registered.projectPath, 'FORBIDDEN', 'Publication is not bound to the registered GitLab host and project')
    requireCondition(persisted && persisted.payload.authorizedRevision === ticket.revision && !ticket.ended && !ticket.stopping && !ticket.mandate.humanHold && !ticket.reconciliation && ticket.inputs.every(entry => entry.state === 'settled') && latestAssignment(ticket)?.state === 'ended' && latestAssignment(ticket)?.generation === effect.generation, 'REVISION_CONFLICT', 'Publication authorization changed; inspect the task before any further delivery')
    return ticket
  }
  private checkpoint(effect: Effect, phase: string): void {
    this.store.atomic(() => {
      this.authorized(effect)
      const persisted = this.store.effects().find(entry => entry.key === effect.key)!
      this.store.saveEffect({ ...persisted, payload: { ...persisted.payload, phase } })
      this.store.audit(effect.ticketId, 'publish.phase', { phase })
    })
  }
  async observe(ticketId: string): Promise<void> {
    const ticket = this.engine.require(ticketId)
    const repository = this.store.repository()!
    requireCondition(ticket.mergeRequest && repository.gitlab && ticket.branch, 'INVALID_STATE', 'Only bound merge requests can be observed')
    const record = await this.gitlab.read(repository.gitlab, ticket.mergeRequest.iid)
    const mergeRequest = validateMergeRequest(record, repository.gitlab, ticket.branch, repository.baseRef)
    const feedback = await this.gitlab.feedback(repository.gitlab, mergeRequest.iid, mergeRequest.headSha)
    for (const entry of feedback) this.engine.receiveFeedback(ticket.id, entry.key, entry.text)
    this.engine.syncMergeRequest(ticket.id, mergeRequest)
    this.store.set(`gitlab:${ticket.id}`, { observedAt: new Date().toISOString(), headSha: mergeRequest.headSha, failures: 0 })
  }
  async reconcile(ticketId: string): Promise<void> {
    const effects = this.store.effects('uncertain').filter(effect => effect.ticketId === ticketId && effect.kind === 'publish')
    requireCondition(effects.length === 1, 'INVALID_STATE', 'Expected exactly one uncertain publication')
    const effect = effects[0]!
    if (effect.payload.phase === 'preflight' && !effect.payload.committedSha) { this.engine.failPublication(effect.key, 'Confirmed interrupted preflight; no delivery writes were started'); return }
    const preview = effect.payload.preview as PublishPreview
    requireCondition(typeof effect.payload.committedSha === 'string', 'RECONCILIATION_REQUIRED', 'No persisted commit checkpoint; inspect Git history manually')
    const rows = await this.gitlab.find(preview.repository, preview.branch)
    requireCondition(rows.length === 1, 'RECONCILIATION_REQUIRED', 'Cannot establish a unique remote MR; no write will be replayed')
    const mergeRequest = validateMergeRequest(rows[0]!, preview.repository, preview.branch, preview.baseRef)
    requireCondition(mergeRequest.headSha === effect.payload.committedSha, 'RECONCILIATION_REQUIRED', 'Remote head does not match the persisted authorized commit')
    this.store.atomic(() => {
      this.engine.syncMergeRequest(ticketId, mergeRequest)
      this.store.saveEffect({ ...effect, state: 'done' })
      const ticket = this.engine.require(ticketId)
      delete ticket.reconciliation
      ticket.revision++
      this.store.save(ticket)
      this.store.audit(ticketId, 'publish.reconciled', { iid: mergeRequest.iid, sha: mergeRequest.headSha })
    })
  }
}
