import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, chmod, lstat, realpath, rm, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { backup } from 'node:sqlite'
import { Store } from '../../storage/src/store.js'
import { DomainError, requireCondition } from '../../core/src/model.js'
import { createProfile, providerSchema, workerAgentsSchema } from '../../executor-codex/src/profile.js'
import { inside, registerRepository } from './workspace.js'

export const defaultState = () => resolve(process.env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.local/state/codex-superagent'))
export const runtimeConfigSchema = z.object({ mode: z.literal('restricted_local').default('restricted_local'), inspectionTtlSeconds: z.number().int().min(10).max(60).default(60), verificationMaxAgeDays: z.number().int().min(1).max(30).default(30), enablementMaxHours: z.number().int().min(1).max(24).default(24) }).strict()
const legacyConfigSchema = z.object({ version: z.literal(2), operatorId: z.string().min(1), concurrency: z.number().int().min(1).max(4), gitlabEnabled: z.boolean().default(false) }).strict()
export const configSchema = legacyConfigSchema.extend({ version: z.literal(3), runtime: runtimeConfigSchema }).strict()
export type ServiceConfig = z.infer<typeof configSchema>
export async function readConfig(state: string): Promise<ServiceConfig> {
  const info = await lstat(state)
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'State directory must be owned by this user with mode 0700')
  const raw = JSON.parse(await readFile(join(state, 'service.json'), 'utf8'))
  requireCondition(raw?.version === 3 && !('githubEnabled' in raw), 'MIGRATION_REQUIRED', 'Service configuration requires explicit migration: superagent-local runtime migrate --state STATE. Legacy GitHub history must use separate state.')
  return configSchema.parse(raw)
}
export async function initialize(state: string, repositoryPath: string, executionRoot: string, model: string, baseRef = 'HEAD', gitlabUrl = 'https://gitlab.com'): Promise<void> {
  const repository = await registerRepository(repositoryPath, executionRoot, baseRef, gitlabUrl)
  state = resolve(state)
  requireCondition(!inside(repository.path, state) && !inside(state, repository.path) && !inside(repository.executionRoot, state) && !inside(state, repository.executionRoot), 'FORBIDDEN', 'State, repository and worktrees must have separate roots')
  requireCondition(state !== homedir(), 'FORBIDDEN', 'Use a dedicated state directory')
  await mkdir(state, { recursive: true, mode: 0o700 })
  requireCondition(await realpath(state) === state, 'FORBIDDEN', 'State path must be canonical')
  requireCondition((await readdir(state)).length === 0, 'INVALID_STATE', 'Initialization requires an empty dedicated state directory; existing data is never overwritten')
  await chmod(state, 0o700)
  await writeFile(join(state, 'service.json'), JSON.stringify(configSchema.parse({ version: 3, operatorId: userInfo().username, concurrency: 1, gitlabEnabled: false, runtime: {} }), null, 2), { flag: 'wx', mode: 0o600 })
  for (const role of ['bridge', 'admin']) await writeFile(join(state, `${role}.token`), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  const store = new Store(join(state, 'tasks.sqlite'))
  try { store.set('repository', repository); store.set('paused', false) } finally { store.close() }
  await createProfile(state, model)
}
export async function migrateConfig(state: string): Promise<void> {
  const info = await lstat(state)
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Migration requires private owned state')
  const previous = legacyConfigSchema.parse(JSON.parse(await readFile(join(state, 'service.json'), 'utf8')))
  const lock = await acquireLock(state)
  const store = new Store(join(state, 'tasks.sqlite'))
  try {
    requireCondition(!store.tickets().some(ticket => ticket.stopping || ticket.reconciliation || ticket.assignments.some(assignment => assignment.state === 'running')) && !store.effects().some(effect => ['running', 'uncertain'].includes(effect.state)), 'RECONCILIATION_REQUIRED', 'Stop and reconcile all executions before migration')
    const repository = store.repository()
    requireCondition(repository && !('github' in repository), 'MIGRATION_REQUIRED', 'GitHub state cannot be reused as GitLab runtime state')
    await mkdir(join(state, 'backups'), { recursive: true, mode: 0o700 })
    const name = `runtime-v2-${Date.now()}`
    const destination = join(state, 'backups', `${name}.sqlite`)
    await backup(store.db, destination)
    await chmod(destination, 0o600)
    await writeFile(join(state, 'backups', `${name}-service.json`), JSON.stringify(previous), { flag: 'wx', mode: 0o600 })
    const oldProfile = JSON.parse(await readFile(join(state, 'worker-profile.json'), 'utf8'))
    await writeFile(join(state, 'backups', `${name}-worker-profile.json`), JSON.stringify(oldProfile), { flag: 'wx', mode: 0o600 })
    await createProfile(state, z.string().min(1).max(200).parse(oldProfile.model), undefined, workerAgentsSchema.parse({ enabled: false }))
    const temporary = join(state, 'service-v3.pending')
    await writeFile(temporary, JSON.stringify(configSchema.parse({ ...previous, version: 3, runtime: {} }), null, 2), { flag: 'wx', mode: 0o600 })
    await import('node:fs/promises').then(fs => fs.rename(temporary, join(state, 'service.json')))
  } finally { store.close(); await lock.release() }
}
export async function configureWorkerProfile(state: string, raw: unknown) {
  await readConfig(state)
  const params = z.object({ model: z.string().min(1).max(200), provider: providerSchema, agents: workerAgentsSchema.optional() }).strict().parse(raw)
  const lock = await acquireLock(state)
  const store = new Store(join(state, 'tasks.sqlite'))
  try {
    requireCondition(!store.tickets().some(ticket => ticket.stopping || ticket.reconciliation || latestRunning(ticket)) && !store.effects().some(effect => ['running', 'uncertain'].includes(effect.state)), 'RECONCILIATION_REQUIRED', 'Stop and reconcile executions before changing Worker identity')
    const previous = JSON.parse(await readFile(join(state, 'worker-profile.json'), 'utf8'))
    await mkdir(join(state, 'backups'), { mode: 0o700, recursive: true })
    await writeFile(join(state, 'backups', `worker-profile-${Date.now()}-${randomBytes(6).toString('hex')}.json`), JSON.stringify(previous), { flag: 'wx', mode: 0o600 })
    const profile = await createProfile(state, params.model, params.provider, params.agents ?? workerAgentsSchema.parse(previous.agents ?? { enabled: false }))
    for (const ticket of store.tickets()) if (ticket.binding) { ticket.restartThread = true; ticket.revision++; store.save(ticket); store.audit(ticket.id, 'runtime.profile_changed', { profileHash: profile.hash }) }
    return { model: profile.model, provider: { id: profile.provider.id, authMode: profile.provider.authMode, endpointOrigin: profile.provider.baseUrl ? new URL(profile.provider.baseUrl).origin : undefined }, agents: profile.agents, profileHash: profile.hash, executionEnabled: false }
  } finally { store.close(); await lock.release() }
}
function latestRunning(ticket: import('../../core/src/model.js').Ticket) { return ticket.assignments.at(-1)?.state === 'running' }
export async function acquireLock(state: string): Promise<{ release(): Promise<void>; owned(): boolean }> {
  const directory = join(state, 'daemon.lock')
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Service lock exists. Inspect status; use recover-lock only after confirming the old service is dead.')
    throw error
  }
  const owner = randomBytes(24).toString('hex')
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }), { mode: 0o600 })
  return { owned() {
    try { return JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')).owner === owner } catch { return false }
  }, async release() {
    const current = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))
    if (current.owner === owner) await rm(directory, { recursive: true })
  } }
}
export async function recoverLock(state: string): Promise<void> {
  try { await readConfig(state) }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'MIGRATION_REQUIRED') throw error
    legacyConfigSchema.parse(JSON.parse(await readFile(join(state, 'service.json'), 'utf8')))
  }
  const lock = JSON.parse(await readFile(join(state, 'daemon.lock/owner.json'), 'utf8'))
  requireCondition(Number.isSafeInteger(lock.pid) && lock.pid > 1, 'FORBIDDEN', 'Invalid lock owner; inspect manually')
  try { process.kill(lock.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(join(state, 'daemon.lock'), { recursive: true }); return }
    throw error
  }
  throw new Error('Lock owner is alive or PID was reused; refusing to remove the lock')
}
