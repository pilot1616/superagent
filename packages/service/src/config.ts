import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, chmod, lstat, realpath, rm, readdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { Store } from '../../storage/src/store.js'
import { requireCondition } from '../../core/src/model.js'
import { createProfile } from '../../executor-codex/src/profile.js'
import { inside, registerRepository } from './workspace.js'

export const defaultState = () => resolve(process.env.SUPERAGENT_STATE_DIR ?? join(homedir(), '.local/state/codex-superagent'))
export const configSchema = z.object({ version: z.literal(1), operatorId: z.string().min(1), concurrency: z.number().int().min(1).max(4), githubEnabled: z.boolean().default(false) }).strict()
export type ServiceConfig = z.infer<typeof configSchema>
export async function readConfig(state: string): Promise<ServiceConfig> {
  const info = await lstat(state)
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'State directory must be owned by this user with mode 0700')
  return configSchema.parse(JSON.parse(await readFile(join(state, 'service.json'), 'utf8')))
}
export async function initialize(state: string, repositoryPath: string, executionRoot: string, model: string, baseRef = 'HEAD'): Promise<void> {
  const repository = await registerRepository(repositoryPath, executionRoot, baseRef)
  state = resolve(state)
  requireCondition(!inside(repository.path, state) && !inside(state, repository.path) && !inside(repository.executionRoot, state) && !inside(state, repository.executionRoot), 'FORBIDDEN', 'State, repository and worktrees must have separate roots')
  requireCondition(state !== homedir(), 'FORBIDDEN', 'Use a dedicated state directory')
  await mkdir(state, { recursive: true, mode: 0o700 })
  requireCondition(await realpath(state) === state, 'FORBIDDEN', 'State path must be canonical')
  requireCondition((await readdir(state)).length === 0, 'INVALID_STATE', 'Initialization requires an empty dedicated state directory; existing data is never overwritten')
  await chmod(state, 0o700)
  await writeFile(join(state, 'service.json'), JSON.stringify({ version: 1, operatorId: userInfo().username, concurrency: 1, githubEnabled: false }, null, 2), { flag: 'wx', mode: 0o600 })
  for (const role of ['bridge', 'admin']) await writeFile(join(state, `${role}.token`), randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  const store = new Store(join(state, 'tasks.sqlite'))
  try { store.set('repository', repository); store.set('paused', false) } finally { store.close() }
  await createProfile(state, model)
}
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
  await readConfig(state)
  const lock = JSON.parse(await readFile(join(state, 'daemon.lock/owner.json'), 'utf8'))
  requireCondition(Number.isSafeInteger(lock.pid) && lock.pid > 1, 'FORBIDDEN', 'Invalid lock owner; inspect manually')
  try { process.kill(lock.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(join(state, 'daemon.lock'), { recursive: true }); return }
    throw error
  }
  throw new Error('Lock owner is alive or PID was reused; refusing to remove the lock')
}
