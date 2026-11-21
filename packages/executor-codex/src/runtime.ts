import { mkdir, realpath, lstat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { ExecutionPermit, RuntimeGate } from '../../core/src/ports.js'
import { requireCondition } from '../../core/src/model.js'
import { AppServer } from './rpc.js'
import { effectiveProfile } from './inspection.js'
import { providerEnvironment, type WorkerProfile } from './profile.js'
import { taskPermissionArguments } from './capabilities.js'
import { git } from '../../service/src/workspace.js'

export interface VerificationPermit { readonly runId: string; readonly fingerprint: string }
const verificationPermits = new WeakMap<VerificationPermit, { authorize(): void; workspace: string }>()
export function issueVerificationPermit(runId: string, fingerprint: string, workspace: string, authorize: () => void): VerificationPermit {
  const permit = Object.freeze({ runId, fingerprint })
  verificationPermits.set(permit, { authorize, workspace })
  return permit
}
type Access = { kind: 'production'; gate: RuntimeGate; permit: ExecutionPermit } | { kind: 'verification'; permit: VerificationPermit }
function authorize(access: Access, workspace: string) {
  if (access.kind === 'production') access.gate.validate(access.permit)
  else { const issued = verificationPermits.get(access.permit); requireCondition(issued && issued.workspace === workspace, 'FORBIDDEN', 'Verification requires a bound temporary fixture permit'); issued.authorize() }
}
export class WorkerRuntime extends AppServer {
  private constructor(binary: string, options: { cwd: string; env: NodeJS.ProcessEnv }, private access: Access, private readRoots: string[], profile: WorkerProfile, private gitWriteRoot?: string) { authorize(access, options.cwd); super(binary, ['app-server', '--listen', 'stdio://', ...taskPermissionArguments(profile.home, profile.capabilities, readRoots, gitWriteRoot)], options) }
  static async create(binary: string, profile: WorkerProfile, workspace: string, temporary: string, access: Access, readRoots: string[] = [], gitWriteRoot?: string) {
    authorize(access, workspace)
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    const temporaryInfo = await lstat(temporary)
    const location = relative(workspace, temporary)
    requireCondition(await realpath(workspace) === workspace && await realpath(temporary) === temporary && temporaryInfo.isDirectory() && !temporaryInfo.isSymbolicLink() && (temporaryInfo.mode & 0o077) === 0 && !!location && location !== '..' && !location.startsWith('../') && !location.startsWith('/'), 'FORBIDDEN', 'Task temporary directory must be canonical, private and inside its workspace')
    const env = await providerEnvironment(profile, temporary)
    for (const path of readRoots) requireCondition(await realpath(path) === path && path !== workspace && !workspace.startsWith(`${path}/`), 'FORBIDDEN', 'Task read roots must be canonical and cannot contain its writable workspace')
    if (gitWriteRoot !== undefined) requireCondition(await realpath(await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === gitWriteRoot && gitWriteRoot !== workspace && !workspace.startsWith(`${gitWriteRoot}/`), 'FORBIDDEN', 'Git write root must be the task workspace common Git directory')
    authorize(access, workspace)
    return new WorkerRuntime(binary, { cwd: workspace, env }, access, [...new Set(readRoots)], profile, gitWriteRoot)
  }
  async prepare(profile: WorkerProfile) {
    await this.initialize()
    const { config } = await this.request<{ config: unknown }>('config/read', { includeLayers: false })
    requireCondition(effectiveProfile(config, profile, this.readRoots, this.gitWriteRoot), 'RUNTIME_UNSUPPORTED', 'Effective Worker policy differs from the reviewed profile')
    if (profile.provider.authMode === 'openai') {
      const account = await this.request<{ account?: unknown }>('account/read', { refreshToken: false })
      requireCondition(account.account, 'AUTH_REQUIRED', 'Worker requires independent project authentication')
    }
  }
  startTurn<Result>(params: unknown, workspace: string, sending: () => void): Promise<Result> {
    authorize(this.access, workspace)
    sending()
    return this.request<Result>('turn/start', params)
  }
}
