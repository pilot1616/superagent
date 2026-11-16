import { Engine } from '../../core/src/engine.js'
import { latestAssignment, requireCondition, type Effect, type PublishPreview, type Ticket } from '../../core/src/model.js'
import type { Persistence } from '../../core/src/ports.js'
import { validatePull, type GitHubPort } from './api.js'
import { previewWorkspace, commitPreview } from './workspace.js'

export class Delivery {
  constructor(private store: Persistence, private engine: Engine, private state: string, private github: GitHubPort, private push: (ticket: Ticket, preview: PublishPreview, sha: string) => Promise<void>) {}
  async preview(approvalId: string, authorName: string, authorEmail: string): Promise<PublishPreview> {
    const approval = this.store.approval(approvalId)
    requireCondition(approval?.kind === 'publish', 'INVALID_STATE', 'A publication request is required')
    const ticket = this.engine.require(approval.ticketId)
    const preview = await previewWorkspace(this.store.repository()!, ticket, this.state, authorName, authorEmail)
    this.engine.attachPreview(approvalId, preview)
    return preview
  }
  async approve(approvalId: string): Promise<void> {
    const approval = this.store.approval(approvalId)
    const approved = approval?.details.preview as PublishPreview | undefined
    requireCondition(approval && approved, 'APPROVAL_REQUIRED', 'Generate and inspect a publication preview first')
    const current = await previewWorkspace(this.store.repository()!, this.engine.require(approval.ticketId), this.state, approved.authorName, approved.authorEmail)
    this.engine.authorizePublish(approvalId, current)
  }
  async publish(effect: Effect): Promise<void> {
    const ticket = this.engine.require(effect.ticketId)
    const preview = effect.payload.preview as PublishPreview
    requireCondition(preview && !ticket.mandate.humanHold && !ticket.reconciliation && latestAssignment(ticket)?.state === 'ended' && latestAssignment(ticket)?.generation === effect.generation, 'INVALID_STATE', 'Publication is no longer authorized')
    const current = await previewWorkspace(this.store.repository()!, { ...ticket, revision: preview.revision }, this.state, preview.authorName, preview.authorEmail)
    requireCondition(current.fingerprint === preview.fingerprint, 'REVISION_CONFLICT', 'Publication contents changed after approval')
    const previous = await this.github.find(preview.repository, preview.branch)
    requireCondition(previous.length <= 1, 'RECONCILIATION_REQUIRED', 'Multiple PRs use this branch')
    if (previous[0]) {
      const pull = validatePull(previous[0], preview.repository, preview.branch, preview.baseRef)
      requireCondition(pull.state === 'open' && (!ticket.pull || pull.number === ticket.pull.number), 'RECONCILIATION_REQUIRED', 'Existing PR is closed or belongs to another binding')
    }
    requireCondition(!this.engine.require(ticket.id).mandate.humanHold, 'INVALID_STATE', 'Task was stopped before publication')
    const commit = await commitPreview(ticket, preview)
    this.store.atomic(() => { this.store.saveEffect({ ...(this.store.effects().find(entry => entry.key === effect.key) ?? effect), state: 'running', payload: { ...effect.payload, committedSha: commit } }); this.store.audit(ticket.id, 'publish.commit_created', { sha: commit }) })
    requireCondition(!this.engine.require(ticket.id).mandate.humanHold, 'INVALID_STATE', 'Task was stopped before push')
    await this.push(ticket, preview, commit)
    requireCondition(!this.engine.require(ticket.id).mandate.humanHold, 'RECONCILIATION_REQUIRED', 'Task stopped after push; inspect the remote branch before any further delivery')
    const record = previous[0] ? await this.github.read(preview.repository, previous[0].number) : await this.github.create(preview.repository, { head: preview.branch, base: preview.baseRef, title: preview.title, body: preview.body })
    const pull = validatePull(record, preview.repository, preview.branch, preview.baseRef)
    requireCondition(pull.headSha === commit, 'RECONCILIATION_REQUIRED', 'Remote PR head differs from the authorized commit')
    this.engine.syncPull(ticket.id, pull)
  }
  async observe(ticketId: string): Promise<void> {
    const ticket = this.engine.require(ticketId)
    const repository = this.store.repository()!
    requireCondition(ticket.pull && repository.github && ticket.branch, 'INVALID_STATE', 'Only bound pull requests can be observed')
    const record = await this.github.read(repository.github, ticket.pull.number)
    const pull = validatePull(record, repository.github, ticket.branch, repository.baseRef)
    const feedback = await this.github.feedback(repository.github, pull.number, pull.headSha)
    for (const entry of feedback) this.engine.receiveFeedback(ticket.id, entry.key, entry.text)
    this.engine.syncPull(ticket.id, pull)
    this.store.set(`github:${ticket.id}`, { observedAt: new Date().toISOString(), headSha: pull.headSha, failures: 0 })
  }
  async reconcile(ticketId: string): Promise<void> {
    const effects = this.store.effects('uncertain').filter(effect => effect.ticketId === ticketId && effect.kind === 'publish')
    requireCondition(effects.length === 1, 'INVALID_STATE', 'Expected exactly one uncertain publication')
    const effect = effects[0]!
    const preview = effect.payload.preview as PublishPreview
    requireCondition(typeof effect.payload.committedSha === 'string', 'RECONCILIATION_REQUIRED', 'No persisted commit checkpoint; inspect Git history manually')
    const rows = await this.github.find(preview.repository, preview.branch)
    requireCondition(rows.length === 1, 'RECONCILIATION_REQUIRED', 'Cannot establish a unique remote PR; no write will be replayed')
    const pull = validatePull(rows[0]!, preview.repository, preview.branch, preview.baseRef)
    requireCondition(pull.headSha === effect.payload.committedSha, 'RECONCILIATION_REQUIRED', 'Remote head does not match the persisted authorized commit')
    this.store.atomic(() => {
      this.engine.syncPull(ticketId, pull)
      this.store.saveEffect({ ...effect, state: 'done' })
      const ticket = this.engine.require(ticketId)
      delete ticket.reconciliation
      ticket.revision++
      this.store.save(ticket)
      this.store.audit(ticketId, 'publish.reconciled', { number: pull.number, sha: pull.headSha })
    })
  }
}
