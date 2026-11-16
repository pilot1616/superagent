import type { Approval, Audit, Effect, Repository, Ticket } from './model.js'

export interface Persistence {
  atomic<Result>(operation: () => Result): Result
  get<Result>(key: string): Result | undefined
  set(key: string, value: unknown): void
  repository(): Repository | undefined
  ticket(id: string): Ticket | undefined
  tickets(): Ticket[]
  save(ticket: Ticket): void
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
  shutdown(): Promise<void>
}
