import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { Engine } from '../../core/src/engine.js'
import { DomainError, latestAssignment, requireCondition, type Plan, type WorkerAgent } from '../../core/src/model.js'
import { scheduling } from '../../core/src/scheduler.js'
import { workspaceBinding, workspaceConfigure, workspaceInput, workspaceSelection, workspaceTools } from '../../core/src/workspace.js'
import { digest, Store } from '../../storage/src/store.js'
import { git, prepareWorkspace, rejectWorkspaceConfiguration } from './workspace.js'

interface Preview {
  id: string; planId: string; revision: number; expiresAt: number
  selection: z.infer<typeof workspaceInput>
  members: { id: string; revision: number; workspace?: string; branch?: string; baseSha?: string }[]
}

export class PlanWorkspaces {
  private preparing = new Map<string, { revision: number; promise: Promise<unknown> }>()
  constructor(private store: Store, private engine: Engine, private active: () => ReadonlySet<string> = () => new Set(), private jobs: () => ReadonlySet<string> = () => new Set()) {}

  private plan(id: string, revision?: number): Plan {
    const plan = this.engine.coordination.require<Plan>('plan', id)
    requireCondition(revision === undefined || plan.revision === revision, 'REVISION_CONFLICT', '计划已变化，请重新预览', 409)
    return plan
  }

  private async resolve(raw: unknown) {
    const selection = workspaceSelection.parse(raw)
    const repository = this.store.repository()!
    requireCondition(selection.repositoryId === repository.id, 'WORKSPACE_REPOSITORY_MISMATCH', '只能使用当前项目登记的仓库；其他仓库请打开对应项目服务', 409)
    requireCondition(await realpath(repository.path) === repository.path, 'FORBIDDEN', 'Repository moved')
    try {
      await git(repository.path, ['check-ref-format', selection.baseRef])
      await git(repository.path, ['check-ref-format', '--branch', `${selection.branchPrefix}/workspace`])
      const baseSha = await git(repository.path, ['rev-parse', '--verify', `${selection.baseRef}^{commit}`])
      return workspaceInput.parse({ ...selection, baseSha })
    } catch { throw new DomainError('WORKSPACE_REF_INVALID', '本地分支引用或工作分支前缀无效；本操作不会 fetch，请核对完整 refs/heads/* 或 refs/remotes/origin/* 引用', 409) }
  }

  async validateInput(raw: unknown): Promise<void> {
    const input = workspaceInput.parse(raw)
    const resolved = await this.resolve({ repositoryId: input.repositoryId, baseRef: input.baseRef, branchPrefix: input.branchPrefix })
    requireCondition(resolved.baseSha === input.baseSha, 'WORKSPACE_REF_MOVED', '分支引用已移动或 SHA 不匹配；请重新预览，不能静默改变基线', 409)
  }

  async validatePlan(plan: Plan): Promise<void> {
    if (!plan.workspace) return
    const snapshot = digest(plan.workspace)
    const repository = this.store.repository()!
    requireCondition(repository.id === plan.workspace.repositoryId, 'WORKSPACE_REPOSITORY_MISMATCH', '计划绑定了其他仓库', 409)
    requireCondition(await realpath(repository.path) === repository.path, 'FORBIDDEN', 'Repository moved')
    const present = await git(repository.path, ['rev-parse', '--verify', `${plan.workspace.baseSha}^{commit}`]).catch(() => '')
    requireCondition(present === plan.workspace.baseSha, 'WORKSPACE_BASE_MISSING', '计划固定基线提交不可用', 409)
    const current = this.plan(plan.id, plan.revision)
    requireCondition(digest(current.workspace) === snapshot && current.ticketIds.every(id => {
      const ticket = this.engine.require(id)
      return ticket.repositoryId === repository.id && digest(ticket.workspaceBinding ?? null) === snapshot
    }), 'WORKSPACE_BASE_MISMATCH', '计划与成员工作区绑定不一致', 409)
  }

  async preview(raw: unknown) {
    const params = workspaceTools.plan_workspace_preview.parse(raw)
    const plan = this.plan(params.planId, params.expectedRevision)
    const members = plan.ticketIds.map(id => { const ticket = this.engine.require(id); return { id, revision: ticket.revision, workspace: ticket.workspace, branch: ticket.branch, baseSha: ticket.baseSha } })
    const selection = await this.resolve({ repositoryId: params.repositoryId, baseRef: params.baseRef, branchPrefix: params.branchPrefix })
    this.plan(plan.id, plan.revision)
    requireCondition(members.every(member => this.engine.require(member.id).revision === member.revision), 'REVISION_CONFLICT', '成员已变化，请重新预览', 409)
    const preview: Preview = { id: randomUUID(), planId: plan.id, revision: plan.revision, expiresAt: Date.now() + 300_000, selection, members }
    this.store.saveEntity('workspace_preview', preview.id, preview)
    return { ...preview, previous: plan.workspace ?? null, targetBranch: selection.baseRef.replace(/^refs\/(?:heads|remotes\/origin)\//, ''), notice: '仅解析本地引用，未 fetch。旧工作区、分支、文件与历史均保留；切换后需重新确认目标。' }
  }

  async configure(raw: unknown) {
    const params = workspaceConfigure.parse(raw)
    const hash = digest(params)
    const prior = this.store.entity<{ hash: string; result: unknown }>('workspace_receipt', params.requestId)
    if (prior) {
      requireCondition(prior.hash === hash, 'REVISION_CONFLICT', '请求 ID 已用于其他操作', 409)
      return prior.result
    }
    const preview = this.store.entity<Preview>('workspace_preview', params.previewId)
    requireCondition(preview && preview.planId === params.planId && preview.revision === params.expectedRevision && preview.expiresAt > Date.now(), 'REVISION_CONFLICT', '预览失效，请重新预览', 409)
    requireCondition(params.confirmation === params.planId, 'APPROVAL_REQUIRED', '请输入完整计划 ID 确认工作区迁移')
    this.plan(params.planId, params.expectedRevision)
    await this.validateInput(preview.selection)
    return this.store.atomic(() => {
      const replay = this.store.entity<{ hash: string; result: unknown }>('workspace_receipt', params.requestId)
      if (replay) { requireCondition(replay.hash === hash, 'REVISION_CONFLICT', '请求 ID 冲突', 409); return replay.result }
      const plan = this.plan(params.planId, params.expectedRevision)
      requireCondition(preview.expiresAt > Date.now() && !plan.completed, 'INVALID_STATE', '计划已完成或预览已过期')
      const tickets = preview.members.map(member => {
        const ticket = this.engine.require(member.id)
        requireCondition(ticket.revision === member.revision && ticket.planId === plan.id, 'REVISION_CONFLICT', '成员已变化，请重新预览', 409)
        requireCondition(!ticket.result && !ticket.mergeRequest && !ticket.stopping && !ticket.reconciliation && (!ticket.ended || ticket.ended === 'stopped'), 'INVALID_STATE', '已验收、已交付、完成或待核对任务不能直接迁移')
        requireCondition(latestAssignment(ticket)?.state !== 'running' && !this.active().has(ticket.id) && !this.jobs().has(ticket.id) && !this.preparing.has(ticket.id), 'WORKSPACE_BUSY', '成员仍在运行或准备工作区，请等待安全停止', 409)
        requireCondition(!this.store.effects().some(effect => effect.ticketId === ticket.id && effect.state !== 'done' && (effect.kind !== 'launch' || effect.state !== 'pending')), 'WORKSPACE_BUSY', '成员存在未完成外部操作', 409)
        requireCondition(!this.store.entities<WorkerAgent>('worker_agent').some(agent => agent.ticketId === ticket.id && agent.cleanup !== 'closed'), 'WORKSPACE_BUSY', '成员子 Agent 尚未清理', 409)
        return ticket
      })
      const binding = workspaceBinding(preview.selection, randomUUID())
      this.store.saveEntity('workspace_archive', binding.id, { plan, tickets, migratedAt: new Date().toISOString(), operatorId: this.engine.operatorId })
      for (const ticket of tickets) {
        for (const effect of this.store.effects('pending')) if (effect.ticketId === ticket.id && effect.kind === 'launch') this.store.saveEffect({ ...effect, state: 'done' })
        const assignment = latestAssignment(ticket)
        if (assignment?.state === 'pending') { assignment.state = 'ended'; assignment.endedAt = new Date().toISOString(); assignment.launchPhase = 'ended' }
        ticket.workspaceBinding = binding
        delete ticket.workspace; delete ticket.branch; delete ticket.baseSha; delete ticket.binding; delete ticket.report; delete ticket.failure
        ticket.restartThread = true
        ticket.mandate.executionGranted = false
        for (const input of ticket.inputs) if (!input.returned && !input.superseded) input.state = 'pending'
        this.store.set(`workspace:blocker:${ticket.id}`, null)
        for (const approval of this.store.approvals(ticket.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
        this.engine.save(ticket, 'workspace.migrated', { bindingId: binding.id, archiveId: binding.id })
      }
      plan.workspace = binding; plan.version++; plan.revision++; delete plan.grant
      for (const approval of this.store.approvals(plan.id)) if (approval.status === 'pending') this.store.saveApproval({ ...approval, status: 'expired' })
      this.store.saveEntity('plan', plan.id, plan)
      this.store.audit(plan.id, 'plan.workspace_configured', { binding, archiveId: binding.id, requestId: params.requestId })
      const result = { planId: plan.id, revision: plan.revision, workspace: binding, archiveId: binding.id, requiresApproval: true }
      this.store.saveEntity('workspace_receipt', params.requestId, { hash, result })
      return result
    })
  }

  review(raw: unknown) {
    const params = z.object({ planId: z.string(), previewId: z.string().uuid() }).strict().parse(raw)
    const preview = this.store.entity<Preview>('workspace_preview', params.previewId)
    requireCondition(preview && preview.planId === params.planId && preview.expiresAt > Date.now(), 'REVISION_CONFLICT', '预览失效，请重新预览', 409)
    this.plan(params.planId, preview.revision)
    return preview
  }

  prepare(raw: unknown, dispatch = false): Promise<unknown> {
    const params = workspaceTools.task_workspace_prepare.parse(raw)
    const pending = this.preparing.get(params.ticketId)
    if (pending) {
      requireCondition(pending.revision === params.expectedRevision, 'REVISION_CONFLICT', '工作区正在按另一版本准备', 409)
      return pending.promise
    }
    const promise = this.prepareTask(params.ticketId, params.expectedRevision, dispatch).finally(() => this.preparing.delete(params.ticketId))
    this.preparing.set(params.ticketId, { revision: params.expectedRevision, promise })
    return promise
  }

  private async prepareTask(id: string, revision: number, dispatch: boolean) {
    const ticket = this.engine.require(id)
    requireCondition(ticket.revision === revision, 'REVISION_CONFLICT', '任务已变化', 409)
    requireCondition(!this.active().has(id) && (dispatch || !this.jobs().has(id)), 'WORKSPACE_BUSY', '任务已在执行或派发', 409)
    const check = () => {
      const current = this.engine.require(id)
      requireCondition(current.revision === revision, 'REVISION_CONFLICT', '准备期间任务已变化；保留工作区供核对', 409)
      const decision = scheduling(this.store, current, this.active(), true)
      requireCondition(decision.state === 'ready', 'WORKSPACE_NOT_READY', `任务不可准备工作区：${decision.state} ${decision.reasons.join('; ')}`, 409)
      return current
    }
    check()
    const plan = ticket.planId ? this.plan(ticket.planId) : undefined
    const dependencies = () => plan ? this.plan(plan.id).dependencies.filter(edge => edge.after === id).map(edge => this.engine.require(edge.before).result!) : []
    const inputs = dependencies()
    const planHash = plan ? digest(plan) : null
    let prepared: Awaited<ReturnType<typeof prepareWorkspace>> | undefined
    try {
      if (plan) await this.validatePlan(plan)
      latestAssignment(ticket)!.inputs = inputs
      prepared = await prepareWorkspace(this.store.repository()!, ticket)
      await rejectWorkspaceConfiguration(prepared.workspace)
      return this.store.atomic(() => {
        const current = check()
        requireCondition((!plan || digest(this.plan(plan.id)) === planHash) && digest(dependencies()) === digest(inputs), 'REVISION_CONFLICT', '准备期间计划或依赖已变化；保留工作区供核对', 409)
        Object.assign(current, prepared)
        this.store.set(`workspace:blocker:${id}`, null)
        this.engine.save(current, 'workspace.prepared', { ...prepared, bindingId: current.workspaceBinding?.id })
        return { ready: true, ...prepared, revision: current.revision, binding: current.workspaceBinding ?? null }
      })
    } catch (error) {
      const current = this.store.ticket(id)
      if (current?.revision !== revision || (plan && digest(this.store.entity<Plan>('plan', plan.id) ?? null) !== planHash)) throw error
      const code = error instanceof DomainError ? error.code : 'WORKSPACE_PREPARATION_FAILED'
      const reason = error instanceof DomainError ? error.message : '工作区准备失败；请检查本地引用、分支冲突、目录权限及磁盘空间后重新检查，不会启动 Worker'
      if (prepared) { Object.assign(current, prepared); this.engine.save(current, 'workspace.prepared_pending_review', prepared) }
      this.store.set(`workspace:blocker:${id}`, { bindingId: current.workspaceBinding?.id, code, reason, at: new Date().toISOString() })
      this.store.audit(id, 'workspace.blocked', { code, reason })
      return { ready: false, code, reason }
    }
  }
}
