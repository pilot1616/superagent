import { z } from 'zod'
import { requireCondition, type PlanWorkspace, type Repository, type Ticket } from './model.js'

const branch = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/).refine(value => !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock'))
export const workspaceSelection = z.object({ repositoryId: z.string().min(1).max(150), baseRef: z.string().max(200).regex(/^refs\/(?:heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/), branchPrefix: branch }).strict()
export const workspaceInput = workspaceSelection.extend({ baseSha: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()
export const workspaceTools = {
  plan_workspace_preview: z.object({ planId: z.string().min(1).max(150), expectedRevision: z.number().int().positive(), ...workspaceSelection.shape }).strict(),
  task_workspace_prepare: z.object({ ticketId: z.string().min(1).max(150), expectedRevision: z.number().int().positive() }).strict(),
}
export const workspaceConfigure = z.object({ planId: z.string().min(1).max(150), expectedRevision: z.number().int().positive(), previewId: z.string().uuid(), requestId: z.string().min(8).max(150), confirmation: z.string() }).strict()
export function workspaceBinding(input: z.infer<typeof workspaceInput>, id: string): PlanWorkspace {
  return { ...workspaceInput.parse(input), id, targetBranch: input.baseRef.replace(/^refs\/(?:heads|remotes\/origin)\//, ''), resolvedAt: new Date().toISOString() }
}
export function workspaceRepository(repository: Repository, ticket: Ticket): Repository {
  const binding = ticket.workspaceBinding
  if (!binding) return repository
  requireCondition(binding.repositoryId === repository.id && ticket.repositoryId === repository.id, 'WORKSPACE_REPOSITORY_MISMATCH', '计划工作区必须绑定当前已登记仓库；其他仓库请使用对应项目服务', 409)
  return { ...repository, baseRef: binding.targetBranch, baseSha: binding.baseSha }
}
