import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, readdir, realpath, lstat } from 'node:fs/promises'
import { constants, statSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { arch, platform, release, homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppServer } from './rpc.js'
import { codexVersion, SUPPORTED_CODEX } from './probe.js'
import { canonicalJson, loadProfile, providerEnvironment, safeWorkerPath, workerEnvironment, type WorkerProfile } from './profile.js'
import { inspectionSchema, type RuntimeInspection } from './contracts.js'

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export async function resolveBinary(binary = 'codex'): Promise<string> {
  for (const candidate of binary.includes('/') ? [binary] : safeWorkerPath.split(':').map(directory => join(directory, binary))) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch {}
  }
  throw new Error('RUNTIME_UNSUPPORTED')
}
async function treeHash(directory: string): Promise<string> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  return sha256(canonicalJson(await Promise.all(entries.filter(entry => entry.isDirectory() || /\.(js|json)$/.test(entry.name)).map(async entry => [entry.name, entry.isDirectory() ? await treeHash(join(directory, entry.name)) : sha256(await readFile(join(directory, entry.name)))]))))
}
export function credentialStamp(profile: WorkerProfile): string {
  const path = profile.provider.authMode === 'env' ? join(profile.home, 'provider-credentials.json') : join(profile.home, '.codex', 'auth.json')
  if (profile.provider.authMode === 'none') return 'no-credentials'
  try {
    const info = statSync(path, { bigint: true })
    return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.mode}`
  } catch { return 'missing' }
}
export function launchStamp(state: string, executable: string): string {
  const profile = JSON.parse(readFileSync(join(state, 'worker-profile.json'), 'utf8')) as WorkerProfile
  const info = statSync(realpathSync(executable), { bigint: true })
  return sha256(canonicalJson({ executable: realpathSync(executable), executableStamp: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`, build: runtimeCodeStamp(), config: sha256(readFileSync(join(profile.home, '.codex', 'config.toml'))), profile: sha256(readFileSync(join(state, 'worker-profile.json'))), authStamp: credentialStamp(profile) }))
}
export function runtimeCodeStamp(): string {
  const tree = (directory: string): unknown[] => readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() || /\.(js|json)$/.test(entry.name)).sort((left, right) => left.name < right.name ? -1 : 1).map(entry => [entry.name, entry.isDirectory() ? tree(join(directory, entry.name)) : sha256(readFileSync(join(directory, entry.name)))])
  return sha256(canonicalJson(['core/src', 'storage/src', 'executor-codex', 'service/src', 'integrations-gitlab/src'].map(name => [name, tree(fileURLToPath(new URL(`../../${name}/`, import.meta.url)))])))
}
export function effectiveProfile(config: any, profile: WorkerProfile): boolean {
  const filesystem = { glob_scan_max_depth: null, ':minimal': 'read', ':workspace_roots': 'write', [dirname(profile.home)]: 'deny', [homedir()]: 'deny' }
  const shell = config.shell_environment_policy
  const environmentMatches = shell?.inherit === 'none' && canonicalJson([...(shell.include_only ?? [])].sort()) === canonicalJson(['HOME', 'PATH', 'TMPDIR']) && Object.keys(shell.set ?? {}).length === 0 && !shell.experimental_use_profile && !shell.filters?.length
  const provider = config.model_providers?.[profile.provider.id]
  const providerMatches = profile.provider.id === 'openai' ? !provider && !config.openai_base_url : provider?.base_url === profile.provider.baseUrl && (provider.env_key ?? null) === (profile.provider.envKey ?? null) && provider.wire_api === 'responses' && provider.requires_openai_auth === false && !provider.experimental_bearer_token && !provider.auth && !provider.aws && !Object.keys(provider.http_headers ?? {}).length && !Object.keys(provider.env_http_headers ?? {}).length && !Object.keys(provider.query_params ?? {}).length && !provider.supports_standalone_web_search
  const permissions = config.permissions?.['superagent-worker']
  const networkMatches = permissions?.network?.enabled === false && Object.entries(permissions.network).every(([key, value]) => key === 'enabled' || value === null)
  const agentsMatch = config.features?.multi_agent === profile.agents.enabled && config.features?.multi_agent_v2 === profile.agents.enabled && (!profile.agents.enabled || (config.agents?.enabled === true && config.agents.max_concurrent_threads_per_session === profile.agents.maxConcurrent && config.agents.max_depth === 1 && config.agents.default_subagent_model === profile.model))
  return config.model === profile.model && (config.model_provider ?? 'openai') === profile.provider.id && providerMatches && environmentMatches && agentsMatch && config.web_search === 'disabled' && config.allow_login_shell === false && config.project_doc_max_bytes === 0 && !permissions?.extends && !permissions?.workspace_roots && canonicalJson(permissions?.filesystem) === canonicalJson(filesystem) && config.cli_auth_credentials_store === 'file' && config.default_permissions === 'superagent-worker' && config.approval_policy === 'on-request' && networkMatches && ['plugins', 'remote_plugin', 'remote_control', 'tool_suggest', 'auth_elicitation', 'apps', 'shell_snapshot'].every(name => config.features?.[name] === false) && Object.keys(config.mcp_servers ?? {}).length === 0 && Object.keys(config.plugins ?? {}).length === 0
}
export async function inspectRuntime(state: string, repositoryId: string, authGeneration: number, ttlSeconds: number, binary = 'codex'): Promise<RuntimeInspection> {
  const executable = await resolveBinary(binary)
  const profile = await loadProfile(state)
  const version = codexVersion(executable)
  const checkedAt = new Date().toISOString()
  const checks: RuntimeInspection['checks'] = [{ key: 'version', status: version === SUPPORTED_CODEX ? 'passed' : 'failed', reasonCode: version === SUPPORTED_CODEX ? undefined : 'RUNTIME_UNSUPPORTED', nextAction: `Use ${SUPPORTED_CODEX}` }, { key: 'platform', status: ['darwin', 'linux'].includes(platform()) ? 'passed' : 'failed', reasonCode: ['darwin', 'linux'].includes(platform()) ? undefined : 'RUNTIME_UNSUPPORTED' }]
  let auth: RuntimeInspection['auth']['status'] = 'unknown'
  if (version === SUPPORTED_CODEX) {
    let environment = workerEnvironment(profile)
    let credentialsValid = true
    try { environment = await providerEnvironment(profile) } catch { credentialsValid = false }
    const server = new AppServer(executable, ['app-server', '--listen', 'stdio://'], { cwd: state, env: environment })
    server.on('request', message => server.send({ id: message.id, error: { code: -32601, message: 'Read-only inspection does not approve runtime requests' } }))
    try {
      await server.initialize()
      checks.push({ key: 'protocol_handshake', status: 'passed' })
      const { config } = await server.request<{ config: unknown }>('config/read', { includeLayers: false })
      checks.push({ key: 'effective_profile', status: effectiveProfile(config, profile) ? 'passed' : 'failed', reasonCode: effectiveProfile(config, profile) ? undefined : 'RUNTIME_UNSUPPORTED', nextAction: 'Inspect managed policy and isolated Worker profile; do not relax sandbox rules' })
      if (profile.provider.authMode === 'openai') {
        const account = await server.request<{ account?: unknown }>('account/read', { refreshToken: false })
        const authPath = join(profile.home, '.codex', 'auth.json')
        const info = await lstat(authPath).catch(() => undefined)
        auth = account.account && info?.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.() ? 'configured' : 'missing'
      } else auth = profile.provider.authMode === 'none' || credentialsValid ? 'configured' : 'missing'
    } catch { checks.push({ key: 'protocol', status: 'failed', reasonCode: 'RUNTIME_UNSUPPORTED', nextAction: 'Inspect the pinned App Server and provider configuration' }) }
    finally { await server.close() }
  }
  checks.push({ key: 'auth', status: auth === 'configured' ? 'passed' : 'failed', reasonCode: auth === 'configured' ? undefined : 'AUTH_REQUIRED', nextAction: auth === 'configured' ? undefined : 'Log in using this project Worker CODEX_HOME in a trusted terminal; never send credentials to a model' })
  const executableHash = sha256(await readFile(executable))
  const runtimeBuildHash = sha256(canonicalJson(await Promise.all(['core', 'storage', 'executor-codex', 'service', 'integrations-gitlab'].map(async name => [name, await treeHash(fileURLToPath(new URL(`../../${name}/src/`, import.meta.url)))]))))
  const protocolSchemaHash = await treeHash(fileURLToPath(new URL('../protocol/', import.meta.url)))
  const policyHash = sha256(canonicalJson({ policyVersion: 1, mode: 'restricted_local', backend: profile.backend, config: profile.config }))
  const provider = { id: profile.provider.id, authMode: profile.provider.authMode, endpointOrigin: profile.provider.baseUrl ? new URL(profile.provider.baseUrl).origin : undefined }
  const fingerprint = sha256(canonicalJson({ version: 1, executable, executableHash, runtimeBuildHash, protocolSchemaHash, profileHash: profile.hash, policyHash, model: profile.model, provider: profile.provider, authGeneration, repositoryId, mode: 'restricted_local', platform: { os: platform(), release: release(), arch: arch() } }))
  return inspectionSchema.parse({ id: randomUUID(), repositoryId, checkedAt, validUntil: new Date(Date.now() + ttlSeconds * 1000).toISOString(), fingerprint, executable: { realpath: executable, version, sha256: executableHash }, platform: { os: platform(), release: release(), arch: arch() }, runtimeBuildHash, protocolSchemaHash, profileHash: profile.hash, policyHash, model: profile.model, provider, agents: profile.agents, auth: { status: auth, generation: authGeneration }, checks })
}
export function publicInspection(inspection?: RuntimeInspection) {
  if (!inspection) return undefined
  return { ...inspection, executable: { ...inspection.executable, realpath: basename(inspection.executable.realpath) } }
}
