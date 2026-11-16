export type Stage = 'draft' | 'queued' | 'working' | 'approval' | 'answer' | 'waiting' | 'review' | 'blocked' | 'failed' | 'stopping' | 'stopped' | 'completed' | 'reconciling'
export interface Repository { id: string; path: string; remote: string; baseRef: string; baseSha: string; executionRoot: string; github?: string }
export interface Input { id: string; text: string; source: 'manual' | 'github'; sequence: number; state: 'pending' | 'sending' | 'accepted' | 'settled'; createdAt: string }
export interface Assignment { id: string; generation: number; state: 'pending' | 'running' | 'ended'; startedAt?: string; endedAt?: string }
export interface Report { state: 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; checks: string[]; question?: string }
export interface Binding { threadId: string; turnId?: string; version: string; profileHash: string }
export interface Pull { number: number; url: string; headSha: string; branch: string; state: 'open' | 'merged' | 'closed' }
export interface Ticket {
  id: string; repositoryId: string; title: string; scope: string; revision: number; createdAt: string; updatedAt: string
  origin: { kind: 'manual'; operatorId: string; requestId: string }
  mandate: { operatorId: string; scope: string; humanHold: boolean; executionGranted: boolean }
  inputs: Input[]; assignments: Assignment[]; report?: Report; binding?: Binding
  workspace?: string; branch?: string; baseSha?: string; pull?: Pull
  ended?: 'completed' | 'stopped'; stopping?: boolean; reconciliation?: string; failure?: string
}
export interface Approval {
  id: string; ticketId: string; kind: 'start' | 'resume' | 'retry' | 'publish' | 'runtime'
  status: 'pending' | 'accepted' | 'declined' | 'expired'; createdAt: string; expiresAt: string
  revision: number; details: Record<string, unknown>; assignmentId?: string
}
export interface Effect { key: string; kind: 'launch' | 'stop' | 'publish'; ticketId: string; generation: number; payload: Record<string, unknown>; state: 'pending' | 'running' | 'uncertain' | 'done'; attempts: number; dueAt: number }
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
  if (ticket.report?.state === 'ready' && ticket.pull?.state === 'open') return 'review'
  return ticket.mandate.executionGranted ? 'waiting' : 'draft'
}
export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message)
}
