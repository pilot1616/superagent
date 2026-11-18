import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { open, mkdir, realpath, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import { requireCondition, DomainError } from '../../core/src/model.js'
import { initialize, readConfig } from './config.js'
import { git } from './workspace.js'
import { invoke, type Envelope } from './ipc.js'

const imported = z.object({ repositoryPath: z.string(), state: z.string(), dashboardUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+$/).optional() }).strict()
export const hostSettings = z.object({ version: z.literal(1), defaultModel: z.string().min(1).max(200).optional(), projects: z.array(imported).default([]) }).strict()
export const projectOpen = z.object({ repositoryPath: z.string().min(1), initialize: z.boolean().default(false), model: z.string().min(1).max(200).optional(), baseRef: z.string().min(1).optional(), gitlabUrl: z.string().optional() }).strict()
type Project = z.infer<typeof imported>
export const defaultProjectsRoot = () => resolve(join(homedir(), '.local/state/superagent'))

export async function repositoryRoot(directory: string): Promise<string> {
  requireCondition(isAbsolute(directory), 'INVALID_REQUEST', 'Use the absolute project path from the current conversation')
  const path = await realpath(directory)
  return realpath(await git(path, ['rev-parse', '--show-toplevel']))
}
async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }) }
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  requireCondition(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && await realpath(path) === path, 'FORBIDDEN', 'Project host directory must be canonical, private and owned by the current user')
}
export async function writePrivateJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export async function configureProjects(root: string, value: unknown) {
  await privateDirectory(root)
  const settings = hostSettings.parse(value)
  for (const project of settings.projects) {
    requireCondition(project.repositoryPath === await repositoryRoot(project.repositoryPath) && project.state === await realpath(project.state), 'INVALID_STATE', 'Imported project paths must be canonical')
    await readConfig(project.state)
    const health = await invoke(project.state, 'bridge', 'health')
    requireCondition(health.ok && (health.data as any)?.repository?.path === project.repositoryPath, 'INVALID_STATE', 'Imported state must be a healthy instance for exactly that repository')
  }
  requireCondition(!await exists(join(root, 'settings.json')), 'INVALID_STATE', 'Host settings already exist; preserve existing project mappings instead of overwriting')
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 })
}
export async function projectSettings(root: string) {
  try { return hostSettings.parse(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hostSettings.parse({ version: 1 }); throw error }
}
async function health(project: Project): Promise<Envelope | undefined> {
  try {
    const result = await invoke(project.state, 'bridge', 'health')
    requireCondition(result.ok, 'RUNTIME_UNAVAILABLE', 'Project service returned an unhealthy response; inspect it before restarting')
    requireCondition((result.data as any)?.repository?.path === project.repositoryPath, 'PROJECT_MISMATCH', 'Service state belongs to another repository; refusing to route')
    return result
  } catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
}
async function start(project: Project) {
  requireCondition(!await exists(join(project.state, 'daemon.lock')), 'RECONCILIATION_REQUIRED', 'Project service is unreachable but its lock exists. Inspect and recover it manually; no second daemon was launched')
  await readConfig(project.state)
  const database = new DatabaseSync(join(project.state, 'tasks.sqlite'), { readOnly: true })
  try {
    const row = database.prepare('SELECT value FROM metadata WHERE key=?').get('repository') as { value: string } | undefined
    requireCondition(row && JSON.parse(row.value).path === project.repositoryPath, 'PROJECT_MISMATCH', 'Stored state belongs to another project; no daemon was launched')
  } finally { database.close() }
  const descriptor = await open(join(project.state, 'daemon.log'), 'a', 0o600)
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve', '--state', project.state, '--with-panel'], { detached: true, cwd: project.repositoryPath, stdio: ['ignore', descriptor.fd, descriptor.fd] })
    await once(child, 'spawn')
    child.unref()
  } finally { await descriptor.close() }
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await health(project)) return
    await delay(100)
  }
  throw new DomainError('RUNTIME_UNAVAILABLE', 'Service startup is not confirmed. Inspect daemon.log before retrying')
}
async function dashboard(project: Project) {
  if (project.dashboardUrl) return project.dashboardUrl
  try {
    const value = z.object({ origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+$/), pid: z.number().int().positive(), instanceId: z.string().uuid(), published: z.literal(true), tokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readFile(join(project.state, 'panel-session.json'), 'utf8')))
    const owner = JSON.parse(await readFile(join(project.state, 'daemon.lock/owner.json'), 'utf8')) as { pid: number }
    const panelOwner = JSON.parse(await readFile(join(project.state, 'panel.lock/owner.json'), 'utf8'))
    if (value.pid !== owner.pid || value.instanceId !== panelOwner.instanceId || value.pid !== panelOwner.pid) return undefined
    const token = await readFile(join(project.state, 'panel-login.token'), 'utf8')
    if (createHash('sha256').update(token).digest('hex') !== value.tokenHash) return undefined
    return value.origin
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export class ProjectSession {
  private bound?: Project
  private selecting = false
  constructor(readonly root: string, readonly roots: () => Promise<string[] | undefined>) {}
  private async validateRoots(repositoryPath: string) {
    const roots = await this.roots()
    if (roots === undefined) return
    const projects = await Promise.all(roots.map(path => repositoryRoot(path).catch(() => undefined)))
    requireCondition(projects.includes(repositoryPath), 'PROJECT_MISMATCH', 'Selected project is not in the current MCP workspace roots')
  }
  async state(): Promise<string> {
    requireCondition(this.bound, 'PROJECT_REQUIRED', 'Call superagent_project_open with the actual current conversation project before managing tasks; no default repository is selected')
    await this.validateRoots(this.bound.repositoryPath)
    requireCondition(await health(this.bound), 'RUNTIME_UNAVAILABLE', 'Project service is unavailable; explicitly reopen the same project to inspect/start it')
    return this.bound.state
  }
  async select(raw: unknown) {
    requireCondition(!this.selecting, 'INVALID_STATE', 'Project selection is already in progress for this connection')
    this.selecting = true
    try { return await this.open(raw) } finally { this.selecting = false }
  }
  private async open(raw: unknown) {
    const params = projectOpen.parse(raw)
    const repositoryPath = await repositoryRoot(params.repositoryPath)
    await this.validateRoots(repositoryPath)
    requireCondition(!this.bound || this.bound.repositoryPath === repositoryPath, 'PROJECT_BOUND', 'This connection is already bound to another project; start a new conversation for a different repository')
    await privateDirectory(this.root)
    const key = createHash('sha256').update(repositoryPath).digest('hex').slice(0, 20)
    const parent = join(this.root, 'p', key)
    await privateDirectory(parent)
    const lock = join(parent, 'opening.lock')
    let acquired = false
    for (let attempt = 0; attempt < 150; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await delay(100) }
    }
    requireCondition(acquired, 'RECONCILIATION_REQUIRED', 'Another project setup is active or its lock is stale. Inspect opening.lock; do not overwrite it')
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, repositoryPath, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
      const settings = await projectSettings(this.root)
      const project = settings.projects.find(entry => entry.repositoryPath === repositoryPath) ?? { repositoryPath, state: join(parent, 's') }
      requireCondition(Buffer.byteLength(join(project.state, 'service.sock')) < 100, 'INVALID_STATE', 'Project socket path is too long; configure a shorter projects-root before initialization')
      let initialized = false
      if (!await exists(project.state)) {
        requireCondition(params.initialize, 'PROJECT_SETUP_REQUIRED', 'This project has no service yet. After explicit setup consent call project_open with initialize=true and an explicit model or configured host defaultModel')
        const model = params.model ?? settings.defaultModel
        requireCondition(model, 'MODEL_REQUIRED', 'Choose an explicit Worker model for project initialization; account credentials are never copied')
        await writeFile(join(parent, 'project.json'), JSON.stringify({ repositoryPath, state: project.state }), { flag: 'wx', mode: 0o600 })
        await initialize(project.state, repositoryPath, join(this.root, 'w', key), model, params.baseRef ?? 'HEAD', params.gitlabUrl)
        initialized = true
      }
      const binding = join(parent, 'project.json')
      if (await exists(binding)) {
        const descriptor = imported.parse(JSON.parse(await readFile(binding, 'utf8')))
        requireCondition(descriptor.repositoryPath === repositoryPath && descriptor.state === project.state, 'PROJECT_MISMATCH', 'Existing project binding changed; inspect it without overwriting')
      }
      let running = await health(project)
      const launched = !running
      if (!running) { await start(project); running = await health(project) }
      requireCondition(running, 'RUNTIME_UNAVAILABLE', 'Project service is unavailable')
      this.bound = project
      let dashboardUrl = await dashboard(project)
      if (launched) for (let attempt = 0; !dashboardUrl && attempt < 50; attempt++) { await delay(100); dashboardUrl = await dashboard(project) }
      return { repository: (running.data as any).repository, state: project.state, dashboardUrl: dashboardUrl ?? null, loginTokenFile: join(project.state, 'panel-login.token'), executionEnabled: (running.data as any).executionEnabled, initialized, launched }
    } finally { await rm(lock, { recursive: true }) }
  }
}
