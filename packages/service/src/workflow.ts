import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Engine, tools } from '../../core/src/engine.js'
import { requireCondition, type Approval, type Plan } from '../../core/src/model.js'
import { digest, Store } from '../../storage/src/store.js'
import { TaskMaterials } from './materials.js'
import { RuntimeController } from './runtime.js'
import type { PlanWorkspaces } from './plan-workspaces.js'

const actionSchema = z.enum(['task_start', 'task_resume', 'task_retry', 'plan_start'])
const controlSchema = z.object({ action: actionSchema, params: z.record(z.string(), z.unknown()) }).strict()

export class WorkflowController {
  private active = new Map<string, { hash: string; promise: Promise<unknown> }>()
  constructor(private store: Store, private engine: Engine, private materials: TaskMaterials, private runtime?: RuntimeController, private workspaces?: PlanWorkspaces) {}

  async decide(id: string, accept: boolean, expectedFingerprint?: string): Promise<Approval> {
    const approval = this.store.approval(id)
    requireCondition(approval, 'NOT_FOUND', 'Approval not found')
    if (approval.kind !== 'plan' || !accept) return this.engine.approve(id, accept, expectedFingerprint)
    const plan = this.engine.coordination.require<Plan>('plan', approval.ticketId)
    await this.workspaces?.validatePlan(plan)
    if (!plan.workflow) return this.engine.approve(id, accept, expectedFingerprint)
    requireCondition(approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now() && approval.revision === plan.revision && expectedFingerprint === approval.details.fingerprint, 'REVISION_CONFLICT', 'Goal confirmation expired or changed')
    const runtime = await this.runtime?.check()
    if (runtime) {
      const reason = runtime.reasonCodes[0] ?? 'RUNTIME_UNAVAILABLE'
      const next = runtime.checks?.find(check => check.status === 'failed' || check.status === 'unknown')?.nextAction
      requireCondition(runtime.canDispatch || runtime.phase === 'ready', reason, `目标暂未启动：${reason}${next ? `。${next}` : '。请展开环境诊断处理此项后重新确认目标。'}`, 409)
    }
    const prepared = await this.materials.preparePlan(plan)
    try {
      const result = this.store.atomic(() => {
        prepared.commit()
        if (runtime) this.runtime!.enableForWorkflow(runtime.revision, runtime.fingerprint!, plan.id)
        return this.engine.approve(id, true, expectedFingerprint)
      })
      prepared.finish()
      return result
    } finally { await prepared.discard() }
  }

  control(raw: unknown): Promise<unknown> {
    const { action, params: input } = controlSchema.parse(raw)
    const params = tools[action].parse(input)
    const request = { action, params }
    const hash = digest(request)
    const receipt = this.store.entity<{ hash: string; result: unknown }>('workflow_control_receipt', params.requestId)
    if (receipt) {
      requireCondition(receipt.hash === hash, 'REVISION_CONFLICT', 'Control request ID was reused with different input')
      return Promise.resolve(receipt.result)
    }
    const pending = this.active.get(params.requestId)
    if (pending) {
      requireCondition(pending.hash === hash, 'REVISION_CONFLICT', 'Control request ID is already in use')
      return pending.promise
    }
    const run = async () => {
      let result: unknown
      if (action === 'plan_start') {
        const planParams = tools.plan_start.parse(params)
        const approvalId = this.store.once(this.engine.operatorId, 'workflow-plan-request', params.requestId, request, () => {
          const plan = this.engine.coordination.require<Plan>('plan', planParams.planId)
          requireCondition(plan.revision === planParams.expectedRevision, 'REVISION_CONFLICT', 'Goal changed; review it again')
          const current = this.store.approvals(plan.id).find(approval => approval.kind === 'plan' && approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now())
          if (current) return current.id
          this.engine.call('plan_start', { ...planParams, requestId: randomUUID() })
          return this.store.approvals(plan.id).find(approval => approval.kind === 'plan' && approval.status === 'pending')!.id
        })
        const approval = this.store.approval(approvalId)!
        if (approval.status !== 'accepted') await this.decide(approvalId, true, String(approval.details.fingerprint))
        result = this.engine.call('plan_get', { planId: planParams.planId })
      } else {
        result = this.store.once(this.engine.operatorId, 'workflow-task-control', params.requestId, request, () => {
          const taskParams = tools[action].parse(params)
          requireCondition(this.engine.require(taskParams.ticketId).revision === taskParams.expectedRevision, 'REVISION_CONFLICT', 'Task changed; review it again')
          const existing = this.store.approvals(taskParams.ticketId).find(approval => approval.kind === action.slice(5) && approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now())
          if (!existing) this.engine.call(action, taskParams)
          const pending = this.store.approvals(taskParams.ticketId).find(approval => approval.kind === action.slice(5) && approval.status === 'pending')
          if (pending) this.engine.approve(pending.id, true)
          this.store.audit(taskParams.ticketId, 'workflow.human_control', { action, requestId: params.requestId })
          return this.engine.view(this.engine.require(taskParams.ticketId))
        })
      }
      this.store.saveEntity('workflow_control_receipt', params.requestId, { hash, result })
      return result
    }
    const promise = run().finally(() => this.active.delete(params.requestId))
    this.active.set(params.requestId, { hash, promise })
    return promise
  }
}
