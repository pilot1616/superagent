import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { digest } from '../../storage/src/store.js'
import { requireCondition } from '../../core/src/model.js'

export interface WorkerProfile { home: string; model: string; hash: string; config: string }
export async function createProfile(stateDir: string, model: string): Promise<WorkerProfile> {
  requireCondition(model.length > 0 && !/[\r\n]/.test(model), 'INVALID_STATE', 'An explicit model is required')
  const home = join(stateDir, 'worker-home')
  await mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 })
  const quote = (value: string) => JSON.stringify(value)
  const config = `model = ${quote(model)}\ndefault_permissions = "superagent-worker"\napproval_policy = "on-request"\nweb_search = "disabled"\nallow_login_shell = false\nproject_doc_max_bytes = 0\n[features]\nplugins = false\nremote_plugin = false\nremote_control = false\ntool_suggest = false\nauth_elicitation = false\napps = false\nmulti_agent = false\nmulti_agent_v2 = false\nshell_snapshot = false\n[permissions.superagent-worker.filesystem]\n":minimal" = "read"\n":workspace_roots" = "write"\n${quote(await realpath(stateDir))} = "deny"\n${quote(homedir())} = "deny"\n[permissions.superagent-worker.network]\nenabled = false\n[shell_environment_policy]\ninherit = "none"\ninclude_only = ["PATH", "HOME", "TMPDIR"]\n`
  await writeFile(join(home, '.codex', 'config.toml'), config, { mode: 0o600 })
  const profile = { home, model, hash: digest(config), config }
  await writeFile(join(stateDir, 'worker-profile.json'), JSON.stringify(profile), { mode: 0o600 })
  return profile
}
export async function loadProfile(stateDir: string): Promise<WorkerProfile> {
  const profile = JSON.parse(await readFile(join(stateDir, 'worker-profile.json'), 'utf8')) as WorkerProfile
  requireCondition(await realpath(profile.home) === join(await realpath(stateDir), 'worker-home'), 'FORBIDDEN', 'Unexpected Worker home')
  requireCondition(digest(await readFile(join(profile.home, '.codex/config.toml'), 'utf8')) === profile.hash, 'FORBIDDEN', 'Worker configuration changed; initialize and verify the profile again')
  return profile
}
export function workerEnvironment(profile: WorkerProfile): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: profile.home, CODEX_HOME: join(profile.home, '.codex'), TMPDIR: join(profile.home, 'tmp'), LANG: 'en_US.UTF-8' }
}
