import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppServer } from './rpc.js'

export const SUPPORTED_CODEX = 'codex-cli 0.154.0-alpha.6.2'
export function codexVersion(binary = 'codex'): string {
  return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
}
export async function probe(binary = 'codex') {
  const version = codexVersion(binary)
  if (version !== SUPPORTED_CODEX) throw new Error(`Unsupported Codex: ${version}; expected ${SUPPORTED_CODEX}`)
  const directory = mkdtempSync(join(tmpdir(), 'superagent-probe-'))
  mkdirSync(join(directory, '.codex'), { mode: 0o700 })
  const server = new AppServer(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: join(directory, '.codex') },
  })
  try {
    await server.initialize()
    const account = await server.request<{ account?: unknown }>('account/read', { refreshToken: false })
    return { version, handshake: true, isolatedProfile: true, accountConfigured: !!account.account, modelTurnTested: false,
      approvalRoundTripTested: false, restartRecoveryTested: false, status: 'protocol-only' }
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probe().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
