export type Stage = 'draft' | 'queued' | 'working' | 'approval' | 'answer' | 'waiting' | 'review' | 'blocked' | 'failed' | 'stopping' | 'stopped' | 'completed' | 'reconciling'
export interface GitLabProject { url: string; projectPath: string }
export interface Repository { id: string; path: string; remote: string; baseRef: string; baseSha: string; executionRoot: string; gitlab?: GitLabProject }
export interface Input { id: string; text: string; source: 'manual' | 'gitlab'; sequence: number; state: 'pending' | 'sending' | 'accepted' | 'settled'; createdAt: string; eventId?: string; contextOnly?: boolean; returned?: boolean; superseded?: boolean }
export interface Assignment { id: string; generation: number; state: 'pending' | 'running' | 'ended'; startedAt?: string; endedAt?: string; inputs?: AcceptedResult[]; planVersion?: number; retryApprovalId?: string; baseSha?: string; resources?: string[]; runtimeFingerprint?: string; runtimeFence?: number; enablementId?: string; launchPhase?: 'claimed' | 'preparing' | 'process_started' | 'turn_sending' | 'turn_acknowledged' | 'cleanup' | 'ended' }
export interface Report { state: 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; checks: string[]; question?: string | null }
export interface Checkpoint { id: string; ticketId: string; assignmentId: string; kind: 'progress' | 'report' | 'system'; scope: string; summary: string; checks: string[]; state?: Report['state']; question?: string | null; createdAt: string }
export interface WorkerAgent { id: string; ticketId: string; assignmentId: string; threadId: string; parentThreadId: string; turnId?: string; role?: string; nickname?: string; scope?: string; status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound' | 'uncertain'; progress?: string; summary?: string; cleanup?: 'closed' | 'uncertain'; createdAt: string; updatedAt: string }
export interface Binding { threadId: string; turnId?: string; version: string; profileHash: string }
export interface MergeRequest { iid: number; url: string; headSha: string; branch: string; state: 'open' | 'merged' | 'closed'; mergedSha?: string }
export interface AcceptedResult { id: string; ticketId: string; kind: 'artifact' | 'code'; content: string; hash: string; sha?: string; acceptedAt: string; operatorId: string; acceptedBy?: 'human' | 'coordinator' }
export interface Dependency { before: string; after: string; condition: 'artifact' | 'code' }
export interface PlanWorkflow { automaticHandoffs: boolean; materialPaths: string[] }
export interface PlanWorkspace { id: string; repositoryId: string; baseRef: string; baseSha: string; targetBranch: string; branchPrefix: string; resolvedAt: string }
export interface Plan { id: string; title: string; revision: number; version: number; ticketIds: string[]; dependencies: Dependency[]; integrationId: string; paused: boolean; held: boolean; heldTicketIds: string[]; maxAttempts: number; expiresAt: string; grant?: { version: number; fingerprint: string }; completed?: boolean; workflow?: PlanWorkflow; workspace?: PlanWorkspace }
export interface Thread { id: string; title: string; revision: number; correlated: string[]; subscriptions: { ticketId: string; mode: 'owning' | 'context'; origin?: boolean }[] }
export interface TaskEvent { id: string; threadIds: string[]; text: string; source: 'manual' | 'gitlab'; createdAt: string; delivered: string[]; owners: string[]; returned: string[]; decision?: { kind: 'accept' | 'attach' | 'ignore' | 'stop'; reason: string; ticketId?: string } }
export interface Ticket {
  id: string; repositoryId: string; title: string; scope: string; revision: number; createdAt: string; updatedAt: string
  origin: { kind: 'manual'; operatorId: string; requestId: string }
  mandate: { operatorId: string; scope: string; humanHold: boolean; executionGranted: boolean }
  inputs: Input[]; assignments: Assignment[]; report?: Report; binding?: Binding; restartThread?: boolean
  workspace?: string; branch?: string; baseSha?: string; mergeRequest?: MergeRequest
  workspaceBinding?: PlanWorkspace
  planId?: string; priority?: number; resources?: string[]; result?: AcceptedResult; reviewRequired?: boolean
  ended?: 'completed' | 'stopped'; stopping?: boolean; reconciliation?: string; failure?: string
}
export interface Approval {
  id: string; ticketId: string; kind: 'start' | 'resume' | 'retry' | 'publish' | 'runtime' | 'plan'
  status: 'pending' | 'accepted' | 'declined' | 'expired'; createdAt: string; expiresAt: string
  revision: number; details: Record<string, unknown>; assignmentId?: string
}
export interface Effect { key: string; kind: 'launch' | 'stop' | 'publish'; ticketId: string; generation: number; payload: Record<string, unknown>; state: 'pending' | 'running' | 'uncertain' | 'done'; attempts: number; dueAt: number; lease?: { owner: string; claimedAt: number; expiresAt: number } }
export interface PublishPreview { ticketId: string; revision: number; provider: 'gitlab'; repository: GitLabProject; branch: string; baseRef: string; baseSha: string; headSha: string; treeSha: string; diff: string; title: string; body: string; authorName: string; authorEmail: string; fingerprint: string }
export interface Audit { sequence: number; ticketId: string; event: string; detail: unknown; at: string }
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
export function stage(ticket: Ticket, approvals: Approval[] = []): Stage {
  if (ticket.stopping) return 'stopping'
  if (ticket.ended === 'stopped') return 'stopped'
  if (ticket.reconciliation) return 'reconciling'
  if (ticket.ended) return 'completed'
  if (approvals.some(approval => approval.status === 'pending')) return 'approval'
  if (ticket.failure) return 'failed'
  if (ticket.report?.question) return 'answer'
  const assignment = latestAssignment(ticket)
  if (assignment?.state === 'pending') return 'queued'
  if (assignment?.state === 'running') return 'working'
  if (ticket.report?.state === 'blocked' || ticket.report?.state === 'failed') return ticket.report.state
  if (ticket.report?.state === 'ready' && ticket.mergeRequest?.state === 'open') return 'review'
  return ticket.mandate.executionGranted ? 'waiting' : 'draft'
}
export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
export function requireCondition(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, message, status)
}
