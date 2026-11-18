import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DomainError, type Approval, type Audit, type Effect, type Repository, type Ticket } from '../../core/src/model.js'

const parse = <Result>(row: unknown): Result | undefined => row ? JSON.parse((row as { value: string }).value) as Result : undefined
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class Store {
  readonly db: DatabaseSync
  private depth = 0
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(filename)
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version > 2) throw new Error(`Unsupported database schema ${version}; restore a compatible backup`)
      if (version === 1 && filename !== ':memory:') {
        const destination = `${filename}.before-v2.sqlite`
        if (!existsSync(destination)) { this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); chmodSync(destination, 0o600) }
      }
      this.atomic(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS approval (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effect (key TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS effect_due ON effect(state,due);
        CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS audit_ticket ON audit(ticket_id,sequence);
        CREATE TABLE IF NOT EXISTS observed (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS entity (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
        PRAGMA user_version=2;
      `))
      if (filename !== ':memory:') chmodSync(filename, 0o600)
    } catch (error) { this.db.close(); throw error }
  }
  atomic<Result>(operation: () => Result): Result {
    const savepoint = `transaction_${++this.depth}`
    this.db.exec(`SAVEPOINT ${savepoint}`)
    try { const result = operation(); this.db.exec(`RELEASE ${savepoint}`); return result }
    catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error }
    finally { this.depth-- }
  }
  get<Result>(key: string): Result | undefined { return parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)) }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  entity<Result>(kind: string, id: string): Result | undefined { return parse(this.db.prepare('SELECT value FROM entity WHERE kind=? AND id=?').get(kind, id)) }
  entities<Result>(kind: string): Result[] { return this.db.prepare('SELECT value FROM entity WHERE kind=? ORDER BY rowid').all(kind).map(row => parse<Result>(row)!) }
  saveEntity(kind: string, id: string, value: unknown): void { this.db.prepare('INSERT INTO entity VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, JSON.stringify(value)) }
  repository(): Repository | undefined { return this.get('repository') }
  ticket(id: string): Ticket | undefined { return parse(this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id)) }
  tickets(): Ticket[] { return this.db.prepare('SELECT value FROM ticket ORDER BY rowid DESC').all().map(row => parse<Ticket>(row)!) }
  save(ticket: Ticket): void { this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket)) }
  approvals(ticketId?: string): Approval[] {
    const rows = ticketId ? this.db.prepare('SELECT value FROM approval WHERE ticket_id=? ORDER BY rowid').all(ticketId) : this.db.prepare('SELECT value FROM approval ORDER BY rowid').all()
    return rows.map(row => parse<Approval>(row)!)
  }
  approval(id: string): Approval | undefined { return parse(this.db.prepare('SELECT value FROM approval WHERE id=?').get(id)) }
  saveApproval(approval: Approval): void { this.db.prepare('INSERT INTO approval VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(approval.id, approval.ticketId, JSON.stringify(approval)) }
  saveEffect(effect: Effect): void { this.db.prepare('INSERT INTO effect VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,due=excluded.due,value=excluded.value').run(effect.key, effect.ticketId, effect.state, effect.dueAt, JSON.stringify(effect)) }
  effects(state?: Effect['state']): Effect[] {
    const rows = state ? this.db.prepare('SELECT value FROM effect WHERE state=? ORDER BY due,rowid').all(state) : this.db.prepare('SELECT value FROM effect ORDER BY due,rowid').all()
    return rows.map(row => parse<Effect>(row)!)
  }
  once<Result>(operator: string, operation: string, requestId: string, input: unknown, action: () => Result): Result {
    return this.atomic(() => {
      const key = JSON.stringify([operator, operation, requestId])
      const hash = digest(input)
      const prior = this.db.prepare('SELECT hash,value FROM idempotency WHERE key=?').get(key) as { hash: string; value: string } | undefined
      if (prior) {
        if (prior.hash !== hash) throw new DomainError('IDEMPOTENCY_CONFLICT', 'The request ID was already used with different content', 409)
        return JSON.parse(prior.value) as Result
      }
      const result = action()
      this.db.prepare('INSERT INTO idempotency VALUES (?,?,?)').run(key, hash, JSON.stringify(result))
      return result
    })
  }
  observed(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM observed WHERE key=?').get(key) }
  observe(key: string): void { this.db.prepare('INSERT OR IGNORE INTO observed VALUES (?)').run(key) }
  audit(ticketId: string, event: string, detail: unknown): void { this.db.prepare('INSERT INTO audit(ticket_id,event,detail,at) VALUES (?,?,?,?)').run(ticketId, event, JSON.stringify(detail), new Date().toISOString()) }
  events(ticketId: string, after = 0, limit = 50): Audit[] {
    return this.db.prepare('SELECT sequence,ticket_id,event,detail,at FROM audit WHERE ticket_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(ticketId, after, limit).map(row => ({ sequence: Number(row.sequence), ticketId: String(row.ticket_id), event: String(row.event), detail: JSON.parse(String(row.detail)), at: String(row.at) }))
  }
  close(): void { this.db.close() }
}
