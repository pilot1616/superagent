import type { Approval, Assignment, Audit, Effect, Repository, Ticket } from './model.js'

export interface ExecutionPermit { readonly assignmentId: string; readonly ticketId: string; readonly fingerprint: string; readonly fence: number; readonly enablementId: string; readonly executable: string }
export interface RuntimeGate {
  blocker(): { reason: string; reasonCodes: string[] } | undefined
  bind(ticket: Ticket, assignment: Assignment): void
  permit(ticket: Ticket): ExecutionPermit
  validate(permit: ExecutionPermit): void
  quarantine(reasonCode: string, assignmentIds: string[]): void
  invalidate?(reasonCode: string): void
  recheck?(): void
}

export interface Persistence {
  atomic<Result>(operation: () => Result): Result
  get<Result>(key: string): Result | undefined
  set(key: string, value: unknown): void
  entity<Result>(kind: string, id: string): Result | undefined
  entities<Result>(kind: string): Result[]
  saveEntity(kind: string, id: string, value: unknown): void
  removeEntity(kind: string, id: string): void
  repository(): Repository | undefined
  ticket(id: string): Ticket | undefined
  tickets(): Ticket[]
  save(ticket: Ticket): void
  removeTicket(id: string): void
  approval(id: string): Approval | undefined
  approvals(ticketId?: string): Approval[]
  saveApproval(approval: Approval): void
  effects(state?: Effect['state']): Effect[]
  saveEffect(effect: Effect): void
  once<Result>(operator: string, operation: string, requestId: string, input: unknown, action: () => Result): Result
  observed(key: string): boolean
  observe(key: string): void
  audit(ticketId: string, event: string, detail: unknown): void
  events(ticketId: string, after?: number, limit?: number): Audit[]
}

export interface Executor {
  readonly active: ReadonlyMap<string, unknown>
  launch(ticket: Ticket): Promise<void>
  stop(ticketId: string): Promise<void>
  decideRuntime(id: string, accept: boolean): Promise<void>
  answerRuntime?(id: string, answers: Record<string, { answers: string[] }>): Promise<void>
  shutdown(): Promise<void>
}
