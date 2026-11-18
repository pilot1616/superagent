import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppServer } from './rpc.js'
import { createProfile, workerEnvironment } from './profile.js'

export const SUPPORTED_CODEX = 'codex-cli 0.154.0-alpha.6.2'
export function codexVersion(binary = 'codex'): string {
  return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
}
export async function checkWorker(state: string, binary = 'codex') {
  const { inspectRuntime, publicInspection } = await import('./inspection.js')
  const inspection = await inspectRuntime(state, 'diagnostic-only', 0, 60, binary)
  return { diagnosticOnly: true, version: inspection.executable.version, compatible: inspection.executable.version === SUPPORTED_CODEX, handshake: inspection.checks.some(check => check.key === 'protocol_handshake' && check.status === 'passed'), restrictedConfigReadback: inspection.checks.some(check => check.key === 'effective_profile' && check.status === 'passed'), accountConfigured: inspection.auth.status === 'configured', model: inspection.model, provider: inspection.provider, inspection: publicInspection(inspection), status: 'diagnostic-only', modelTurnTested: false, filesystemIsolationTested: false, next: '本检查不登录、不执行模型、不形成生产验收证据；还需真实隔离、预算、请求、取消及多任务验收。' }
}
export async function probe(binary = 'codex') {
  const version = codexVersion(binary)
  if (version !== SUPPORTED_CODEX) throw new Error(`Unsupported Codex: ${version}; expected ${SUPPORTED_CODEX}`)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-probe-')))
  const profile = await createProfile(directory, 'verification-only')
  const server = new AppServer(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: directory, env: workerEnvironment(profile),
  })
  try {
    await server.initialize()
    const { config } = await server.request<{ config: any }>('config/read', { includeLayers: false })
    const { effectiveProfile } = await import('./inspection.js')
    const restrictedConfigReadback = effectiveProfile(config, profile)
    if (!restrictedConfigReadback) throw new Error('Restricted Worker configuration did not survive App Server resolution')
    const account = await server.request<{ account?: unknown }>('account/read', { refreshToken: false })
    return { version, handshake: true, isolatedProfile: true, restrictedConfigReadback, filesystemIsolationTested: false, accountConfigured: !!account.account, modelTurnTested: false,
      approvalRoundTripTested: false, restartRecoveryTested: false, status: 'protocol-only' }
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probe().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
