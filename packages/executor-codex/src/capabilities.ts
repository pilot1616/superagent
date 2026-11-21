import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, realpath, readdir, readFile, writeFile, symlink, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { z } from 'zod'
import { requireCondition } from '../../core/src/model.js'

const execute = promisify(execFile)
const pathSchema = z.string().min(1).max(4096).refine(isAbsolute, 'Use an absolute path')
const environmentSchema = z.object({ DEVELOPER_DIR: pathSchema.optional(), SDKROOT: pathSchema.optional(), JAVA_HOME: pathSchema.optional(), VIRTUAL_ENV: pathSchema.optional(), LANG: z.string().regex(/^[A-Za-z0-9_.@-]{1,80}$/).optional(), LC_ALL: z.string().regex(/^[A-Za-z0-9_.@-]{1,80}$/).optional() }).strict()
const toolchainSchema = z.object({ pathEntries: z.array(pathSchema).max(20).default([]), readRoots: z.array(pathSchema).max(20).default([]), environment: environmentSchema.default({}), gitExecutable: pathSchema.optional() }).strict()
export const capabilitiesInputSchema = z.object({ skills: z.array(pathSchema).max(20).default([]), toolchain: toolchainSchema.omit({ gitExecutable: true }).default({ pathEntries: [], readRoots: [], environment: {} }) }).strict()
export const capabilitiesSchema = z.object({ skillsRoot: pathSchema.optional(), skills: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), path: pathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20), toolchain: toolchainSchema }).strict()
export type WorkerCapabilities = z.infer<typeof capabilitiesSchema>
export const baseWorkerPath = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'
export const resourceHash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
export const containsPath = (root: string, path: string) => { const location = relative(root, path); return !location || (location !== '..' && !location.startsWith('../') && !isAbsolute(location)) }
const credentialName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.git|\.codex|\.agents|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|auth\.json|provider-credentials\.json|.*\.token|.*\.sqlite(?:-.*)?)$/i

export async function requireProtectedStorage(state: string) {
  const canonical = await realpath(state)
  for (const temporary of [tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']) {
    const root = await realpath(temporary).catch(() => undefined)
    requireCondition(!root || !containsPath(root, canonical), 'FORBIDDEN', 'Protected Worker resources must be stored outside system temporary directories, which have implicit sandbox access')
  }
}

export function protectedSource(path: string, state: string, extra: string[] = []) {
  const protectedRoots = [state, join(homedir(), '.codex'), join(homedir(), '.agents'), join(homedir(), '.ssh'), join(homedir(), '.aws'), join(homedir(), '.azure'), join(homedir(), '.kube'), join(homedir(), '.local/state/superagent'), ...extra]
  requireCondition(!protectedRoots.some(root => containsPath(root, path) || containsPath(path, root)) && !path.split('/').some(part => credentialName.test(part)), 'FORBIDDEN', 'Control data, credentials and other task workspaces cannot be shared as development resources')
}

export async function skillTree(source: string, destination?: string): Promise<string> {
  const root = await realpath(source)
  let count = 0
  let bytes = 0
  const walk = async (path: string, ancestors: Set<string>, output?: string): Promise<unknown> => {
    requireCondition(++count <= 4000, 'FORBIDDEN', 'Skill exceeds 4000 entries')
    const target = await realpath(path)
    requireCondition(containsPath(root, target) && !ancestors.has(target), 'FORBIDDEN', 'Skill links must stay inside their source and cannot be cyclic')
    const info = await lstat(target)
    requireCondition(info.isDirectory() || info.isFile(), 'FORBIDDEN', 'Skills may contain only directories and regular files')
    if (info.isDirectory()) {
      if (output) await mkdir(output, { recursive: true, mode: 0o700 })
      const entries = (await readdir(target)).sort()
      const parents = new Set([...ancestors, target])
      return Promise.all(entries.map(async name => {
        requireCondition(!credentialName.test(name), 'FORBIDDEN', 'Do not import credentials or execution configuration with a skill')
        return [name, await walk(join(target, name), parents, output && join(output, name))]
      }))
    }
    requireCondition((bytes += info.size) <= 16 * 1024 * 1024, 'FORBIDDEN', 'Skill exceeds 16 MiB')
    const contents = await readFile(target)
    if (output) await writeFile(output, contents, { flag: 'wx', mode: info.mode & 0o111 ? 0o700 : 0o600 })
    return resourceHash(contents)
  }
  return resourceHash(JSON.stringify(await walk(root, new Set(), destination)))
}

export async function defaultToolchain(): Promise<WorkerCapabilities['toolchain']> {
  const toolchain = toolchainSchema.parse({})
  if (process.platform === 'darwin') {
    try {
      const developer = await realpath((await execute('/usr/bin/xcode-select', ['-p'], { timeout: 3000 })).stdout.trim())
      toolchain.environment.DEVELOPER_DIR = developer
      toolchain.readRoots.push(developer)
      const git = await realpath((await execute('/usr/bin/xcrun', ['--find', 'git'], { timeout: 3000, env: { PATH: baseWorkerPath, DEVELOPER_DIR: developer } })).stdout.trim())
      toolchain.gitExecutable = git
      toolchain.pathEntries.push(dirname(git))
    } catch {}
  }
  if (!toolchain.gitExecutable) {
    for (const directory of baseWorkerPath.split(':')) {
      const path = await realpath(join(directory, 'git')).catch(() => undefined)
      if (path) { toolchain.gitExecutable = path; break }
    }
  }
  return toolchain
}

export async function prepareCapabilities(state: string, raw: unknown, protectedRoots: string[]): Promise<WorkerCapabilities> {
  const params = capabilitiesInputSchema.parse(raw)
  if (params.skills.length) await requireProtectedStorage(state)
  const detected = await defaultToolchain()
  const toolchain = toolchainSchema.parse({ pathEntries: [...params.toolchain.pathEntries, ...detected.pathEntries], readRoots: [...params.toolchain.readRoots, ...detected.readRoots], environment: { ...detected.environment, ...params.toolchain.environment } })
  for (const [key, value] of Object.entries(toolchain.environment)) {
    if (['DEVELOPER_DIR', 'SDKROOT', 'JAVA_HOME', 'VIRTUAL_ENV'].includes(key)) toolchain.environment[key as 'DEVELOPER_DIR'] = await realpath(value)
  }
  const pathVariables = Object.entries(toolchain.environment).filter(([key]) => ['DEVELOPER_DIR', 'SDKROOT', 'JAVA_HOME', 'VIRTUAL_ENV'].includes(key)).map(([, value]) => value)
  toolchain.pathEntries = [...new Set(await Promise.all(toolchain.pathEntries.map(path => realpath(path))))]
  toolchain.readRoots = [...new Set(await Promise.all([...toolchain.readRoots, ...toolchain.pathEntries, ...pathVariables].map(path => realpath(path))))]
  for (const path of [...toolchain.pathEntries, ...toolchain.readRoots]) {
    protectedSource(path, state, protectedRoots)
    requireCondition((await lstat(path)).isDirectory(), 'FORBIDDEN', 'Toolchain roots must be directories')
  }
  for (const directory of [...toolchain.pathEntries, ...baseWorkerPath.split(':')]) {
    const path = await realpath(join(directory, 'git')).catch(() => undefined)
    if (path) { toolchain.gitExecutable = path; break }
  }
  const skillsRoot = params.skills.length ? join(state, 'worker-skills', randomUUID()) : undefined
  const skills: WorkerCapabilities['skills'] = []
  if (skillsRoot) await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
  try {
    for (const source of params.skills) {
      const canonical = await realpath(source)
      requireCondition(!protectedRoots.some(root => containsPath(root, canonical)) && !containsPath(state, canonical), 'FORBIDDEN', 'A task workspace or service state cannot supply global Worker skills')
      const name = basename(canonical)
      requireCondition(/^[a-zA-Z0-9_-]{1,100}$/.test(name) && !skills.some(skill => skill.name === name), 'INVALID_REQUEST', 'Choose uniquely named skill directories')
      requireCondition((await lstat(join(canonical, 'SKILL.md'))).isFile(), 'INVALID_REQUEST', 'Each selected skill requires a regular SKILL.md')
      const path = join(skillsRoot!, name)
      const sha256 = await skillTree(canonical, path)
      requireCondition(await skillTree(path) === sha256, 'REVISION_CONFLICT', 'Skill changed while importing; review it again')
      skills.push({ name, path, sha256 })
    }
    return capabilitiesSchema.parse({ skillsRoot, skills, toolchain })
  } catch (error) { if (skillsRoot) await rm(skillsRoot, { recursive: true, force: true }); throw error }
}

export async function activateSkills(home: string, capabilities: WorkerCapabilities) {
  for (const parent of [join(home, '.agents')]) {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const info = await lstat(parent)
    requireCondition(info.isDirectory() && !info.isSymbolicLink() && await realpath(parent) === parent && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Worker skill discovery parent must be private and owned')
    const path = join(parent, 'skills')
    const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    requireCondition(!existing || existing.isSymbolicLink(), 'FORBIDDEN', 'Inspect unmanaged Worker skills before replacing them')
    if (!capabilities.skillsRoot) { if (existing) await rm(path); continue }
    const temporary = `${path}.${randomUUID()}`
    await symlink(capabilities.skillsRoot, temporary)
    await rename(temporary, path)
  }
}

export const capabilityReadRoots = (capabilities?: WorkerCapabilities) => [...new Set([...(capabilities?.toolchain.readRoots ?? []), ...(capabilities?.skillsRoot ? [capabilities.skillsRoot] : [])])]
export const capabilityShell = (capabilities?: WorkerCapabilities): Record<string, string> => capabilities ? { GIT_OPTIONAL_LOCKS: '0', PATH: [...capabilities.toolchain.pathEntries, ...baseWorkerPath.split(':')].join(':'), ...capabilities.toolchain.environment } : {}
export const workerFilesystem = (home: string, capabilities?: WorkerCapabilities, readRoots: string[] = [], gitWriteRoot?: string) => ({ ':minimal': 'read', ':workspace_roots': 'write', [dirname(home)]: 'deny', [homedir()]: 'deny', ...Object.fromEntries([...capabilityReadRoots(capabilities), ...readRoots].map(path => [path, 'read'])), ...(gitWriteRoot ? { [gitWriteRoot]: 'write' } : {}) })
export function taskPermissionArguments(home: string, capabilities: WorkerCapabilities | undefined, readRoots: string[], gitWriteRoot?: string): string[] {
  if (!readRoots.length && !gitWriteRoot) return []
  const filesystem = Object.entries(workerFilesystem(home, capabilities, readRoots, gitWriteRoot)).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')
  return ['-c', 'default_permissions="superagent-worker"', '-c', `permissions.superagent-worker.filesystem={${filesystem}}`, '-c', 'permissions.superagent-worker.network.enabled=false']
}
