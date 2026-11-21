import { mkdir, readFile, writeFile, realpath, lstat, rename, rm, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { digest } from '../../storage/src/store.js'
import { requireCondition } from '../../core/src/model.js'
import { z } from 'zod'
import { activateSkills, baseWorkerPath, capabilitiesSchema, capabilityReadRoots, capabilityShell, containsPath, defaultToolchain, requireProtectedStorage, skillTree, type WorkerCapabilities } from './capabilities.js'

export const providerSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), authMode: z.enum(['openai', 'env', 'none']), baseUrl: z.string().url().max(500).optional(), envKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional() }).strict().superRefine((provider, context) => {
  if (provider.id === 'openai' && provider.authMode === 'openai' && !provider.baseUrl && !provider.envKey) return
  if (provider.id === 'openai' || provider.authMode === 'openai' || !provider.baseUrl || (provider.authMode === 'env') !== !!provider.envKey) { context.addIssue({ code: 'custom', message: 'Unsupported provider authentication contract' }); return }
  const endpoint = new URL(provider.baseUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))) context.addIssue({ code: 'custom', message: 'Provider requires a credential-free HTTPS endpoint or explicit loopback HTTP endpoint' })
})
export const workerAgentsSchema = z.object({ enabled: z.boolean().default(true), maxConcurrent: z.number().int().min(1).max(4).default(3), maxDepth: z.literal(1).default(1) }).strict()
export type WorkerAgentsConfig = z.infer<typeof workerAgentsSchema>
const profileSchema = z.object({ version: z.literal(2), home: z.string().max(4096), model: z.string().min(1).max(200), hash: z.string().regex(/^[a-f0-9]{64}$/), config: z.string().max(40000), provider: providerSchema, backend: z.literal('codex_named_permissions'), agents: workerAgentsSchema.default({ enabled: false, maxConcurrent: 3, maxDepth: 1 }), capabilities: capabilitiesSchema.optional() }).strict()
export type WorkerProfile = z.infer<typeof profileSchema>
export const safeWorkerPath = baseWorkerPath

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  return JSON.stringify(value)
}

export async function createProfile(stateDir: string, model: string, provider = providerSchema.parse({ id: 'openai', authMode: 'openai' }), agents = workerAgentsSchema.parse({}), capabilities?: WorkerCapabilities): Promise<WorkerProfile> {
  provider = providerSchema.parse(provider)
  agents = workerAgentsSchema.parse(agents)
  capabilities = capabilitiesSchema.parse(capabilities ?? { skills: [], toolchain: await defaultToolchain() })
  requireCondition(model.length > 0 && !/[\r\n]/.test(model), 'INVALID_STATE', 'An explicit model is required')
  const home = join(stateDir, 'worker-home')
  await mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 })
  requireCondition(await realpath(stateDir) === stateDir, 'FORBIDDEN', 'Worker state must be canonical')
  for (const path of [home, join(home, '.codex')]) {
    const info = await lstat(path)
    requireCondition(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Worker configuration directories must be private, owned and canonical')
  }
  const quote = (value: string) => JSON.stringify(value)
  const config = `model = ${quote(model)}\ndefault_permissions = "superagent-worker"\napproval_policy = "on-request"\nweb_search = "disabled"\nallow_login_shell = false\nproject_doc_max_bytes = 0\n[features]\nplugins = false\nremote_plugin = false\nremote_control = false\ntool_suggest = false\nauth_elicitation = false\napps = false\nmulti_agent = false\nmulti_agent_v2 = false\nshell_snapshot = false\n[permissions.superagent-worker.filesystem]\n":minimal" = "read"\n":workspace_roots" = "write"\n${quote(await realpath(stateDir))} = "deny"\n${quote(homedir())} = "deny"\n[permissions.superagent-worker.network]\nenabled = false\n[shell_environment_policy]\ninherit = "none"\ninclude_only = ["PATH", "HOME", "TMPDIR"]\n`
  const providerConfig = provider.id === 'openai' ? '' : `model_provider = ${quote(provider.id)}\n[model_providers.${provider.id}]\nname = ${quote(provider.id)}\nbase_url = ${quote(provider.baseUrl!)}\nwire_api = "responses"\nrequires_openai_auth = false\n${provider.envKey ? `env_key = ${quote(provider.envKey)}\n` : ''}`
  const agentConfig = `[agents]\nenabled = ${agents.enabled}\nmax_concurrent_threads_per_session = ${agents.maxConcurrent}\nmax_depth = ${agents.maxDepth}\ndefault_subagent_model = ${quote(model)}\n`
  const grants = capabilityReadRoots(capabilities).map(path => `${quote(path)} = "read"\n`).join('')
  const shell = Object.entries(capabilityShell(capabilities)).map(([key, value]) => `${quote(key)} = ${quote(value)}\n`).join('')
  const effectiveConfig = `cli_auth_credentials_store = "file"\n${provider.id !== 'openai' ? `model_provider = ${quote(provider.id)}\n` : ''}${config.replace('multi_agent = false', `multi_agent = ${agents.enabled}`).replace('multi_agent_v2 = false', `multi_agent_v2 = ${agents.enabled}`).replace('[permissions.superagent-worker.network]', `${grants}[permissions.superagent-worker.network]`)}[shell_environment_policy.set]\n${shell}${providerConfig.replace(/^model_provider = .*\n/, '')}${agentConfig}`
  await activateSkills(home, capabilities)
  await privateWrite(join(home, '.codex', 'config.toml'), effectiveConfig)
  const profile = profileSchema.parse({ version: 2, home, model, hash: digest(canonicalJson({ config: effectiveConfig, capabilities })), config: effectiveConfig, provider, backend: 'codex_named_permissions', agents, capabilities })
  await privateWrite(join(stateDir, 'worker-profile.json'), JSON.stringify(profile))
  return profile
}
async function privateWrite(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export async function loadProfile(stateDir: string): Promise<WorkerProfile> {
  const profile = profileSchema.parse(JSON.parse(await readFile(join(stateDir, 'worker-profile.json'), 'utf8')))
  requireCondition(await realpath(profile.home) === join(await realpath(stateDir), 'worker-home'), 'FORBIDDEN', 'Unexpected Worker home')
  const config = await readFile(join(profile.home, '.codex/config.toml'), 'utf8')
  requireCondition((profile.capabilities ? digest(canonicalJson({ config, capabilities: profile.capabilities })) : digest(config)) === profile.hash, 'FORBIDDEN', 'Worker configuration changed; initialize and verify the profile again')
  for (const path of [profile.home, join(profile.home, '.codex')]) {
    const info = await lstat(path)
    requireCondition(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Worker home must be private and owned')
  }
  if (profile.capabilities) {
    const { skillsRoot, skills } = profile.capabilities
    if (skillsRoot) await requireProtectedStorage(stateDir)
    requireCondition(!skills.length || skillsRoot && containsPath(join(stateDir, 'worker-skills'), skillsRoot) && await realpath(skillsRoot) === skillsRoot, 'FORBIDDEN', 'Skill snapshot root changed')
    if (skillsRoot) requireCondition(canonicalJson((await readdir(skillsRoot)).sort()) === canonicalJson(skills.map(skill => skill.name).sort()), 'FORBIDDEN', 'Skill snapshot membership changed')
    for (const skill of skills) requireCondition(skill.path === join(skillsRoot!, skill.name) && await skillTree(skill.path) === skill.sha256, 'FORBIDDEN', 'Worker skill snapshot changed; reimport and review the capabilities')
    for (const parent of ['.agents']) {
      const info = await lstat(join(profile.home, parent))
      requireCondition(info.isDirectory() && !info.isSymbolicLink() && await realpath(join(profile.home, parent)) === join(profile.home, parent), 'FORBIDDEN', 'Worker skill discovery parent changed')
      const path = join(profile.home, parent, 'skills')
      const target = await realpath(path).catch(() => undefined)
      requireCondition(target === skillsRoot, 'FORBIDDEN', 'Worker skill discovery directory changed')
    }
  }
  return profile
}
export function workerEnvironment(profile: WorkerProfile, taskTemporary?: string): NodeJS.ProcessEnv {
  return { ...capabilityShell(profile.capabilities), PATH: [...(profile.capabilities?.toolchain.pathEntries ?? []), safeWorkerPath].join(':'), HOME: profile.home, CODEX_HOME: join(profile.home, '.codex'), TMPDIR: taskTemporary ?? join(profile.home, 'tmp'), LANG: profile.capabilities?.toolchain.environment.LANG ?? 'en_US.UTF-8' }
}
export async function providerEnvironment(profile: WorkerProfile, temporary?: string): Promise<NodeJS.ProcessEnv> {
  const environment = workerEnvironment(profile, temporary)
  if (profile.provider.authMode === 'env') {
    const path = join(profile.home, 'provider-credentials.json')
    const info = await lstat(path)
    requireCondition(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Provider credentials require an owned private file')
    const { secret } = z.object({ secret: z.string().min(1).max(16000) }).strict().parse(JSON.parse(await readFile(path, 'utf8')))
    environment[profile.provider.envKey!] = secret
  }
  return environment
}
