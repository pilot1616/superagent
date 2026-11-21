import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requiredCapabilities, verificationDefaults, verificationSchema, type RuntimeInspection, type RuntimeVerification, type VerificationLimits } from './contracts.js'
import { canonicalJson, loadProfile } from './profile.js'
import { issueVerificationPermit, WorkerRuntime } from './runtime.js'
import { sha256 } from './inspection.js'
import { declineResponse, decodeRequest } from './approvals.js'
import type { RpcMessage } from './rpc.js'
import type { ProcessIdentity } from './processes.js'

export const verificationSuiteVersion = 'restricted-local-v1'
export const verificationScenarios = [
  { key: 'V1', title: '协议与独立环境', capabilities: ['protocol_handshake', 'effective_profile'] },
  { key: 'V2', title: '可信本地 Git 写入与文件、凭据、网络边界', capabilities: ['tool_filesystem_boundary', 'tool_network_boundary', 'protected_control_data'] },
  { key: 'V3', title: '真实模型修改、离线检查与结构化报告', capabilities: ['authenticated_model_turn', 'local_edit_and_check'] },
  { key: 'V4', title: '真实权限拒绝及人工澄清', capabilities: ['approval_decline_round_trip', 'user_input_round_trip'] },
  { key: 'V5', title: '真实中断与进程清理', capabilities: ['cancellation_supported_scope'] },
  { key: 'V6', title: '真实输入投递中断与重启核对', capabilities: ['crash_reconciliation'] },
  { key: 'V7', title: '两个真实根节点并行、人工验收后集成及调整', capabilities: ['real_multi_task_dag'] },
] as const

export function newVerification(repositoryId: string, fingerprint: string, limits: VerificationLimits = verificationDefaults): RuntimeVerification {
  return verificationSchema.parse({ id: randomUUID(), repositoryId, revision: 1, fingerprint, suiteVersion: verificationSuiteVersion, mode: 'restricted_local', backend: 'codex_named_permissions', state: 'prepared', limits, capabilities: Object.fromEntries(requiredCapabilities.map(key => [key, { status: 'not_run', evidenceIds: [] }])), evidence: [] })
}

export class VerificationRunner {
  private server?: WorkerRuntime
  private aborted = false
  private running?: Promise<RuntimeVerification>
  constructor(private stateDir: string, readonly verification: RuntimeVerification, private inspection: RuntimeInspection, private authorize: () => void, private persist: (value: RuntimeVerification) => void, private recordProcess: (record: { runId: string; pid: number; epoch: string; startedAt: string; state: string; observed: ProcessIdentity[] }) => void) {}
  run() { return this.running ??= this.execute() }
  async cancel() { this.aborted = true; if (this.server) await this.server.close(); return this.running }
  private async evidence(detail: unknown, source: RuntimeVerification['evidence'][number]['source'] = 'harness') {
    const id = randomUUID()
    const relativePath = `${id}.json`
    const contents = canonicalJson(detail)
    const directory = join(this.stateDir, 'runtime/evidence', this.verification.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, relativePath), contents, { mode: 0o600, flag: 'wx' })
    this.verification.evidence.push({ id, relativePath, sha256: sha256(contents), source })
    return id
  }
  private async execute(): Promise<RuntimeVerification> {
    const value = this.verification
    value.state = 'running'; value.startedAt = new Date().toISOString(); value.revision++
    this.persist(value)
    const timer = setTimeout(() => { void this.cancel().catch(() => undefined) }, value.limits.deadlineSeconds * 1000)
    let fixture: string | undefined
    try {
      this.authorize()
      fixture = await realpath(await mkdtemp(join(tmpdir(), 'superagent-verification-')))
      await writeFile(join(fixture, 'task.json'), JSON.stringify({ suite: verificationSuiteVersion, runId: value.id, trustedFixture: true }), { mode: 0o600 })
      const profile = await loadProfile(this.stateDir)
      const permit = issueVerificationPermit(value.id, value.fingerprint, fixture, () => { if (this.aborted) throw new Error('VERIFICATION_CANCELLED'); this.authorize() })
      this.server = await WorkerRuntime.create(this.inspection.executable.realpath, profile, fixture, join(fixture, 'tmp'), { kind: 'verification', permit })
      this.saveProcess('running')
      this.server.on('request', (message: RpcMessage) => {
        try { decodeRequest(message.method ?? '', message.params); this.server!.send({ id: message.id, result: declineResponse(message.method ?? '') }) }
        catch { this.server!.send({ id: message.id, error: { code: -32601, message: 'Unsupported verification request; permission was not granted' } }) }
      })
      await this.server.prepare(profile)
      const evidenceId = await this.evidence({ suiteVersion: verificationSuiteVersion, runId: value.id, fingerprint: value.fingerprint, observed: ['initialize', 'config/read', 'account/read when required'], modelTurns: 0, backend: value.backend }, 'app_server')
      for (const key of ['protocol_handshake', 'effective_profile']) value.capabilities[key] = { status: 'passed', evidenceIds: [evidenceId] }
      const budgetEvidence = await this.evidence({ reasonCode: 'VERIFICATION_BUDGET_UNSUPPORTED', protocolVersion: this.inspection.executable.version, modelTurns: 0, detail: 'The pinned turn/start contract has no enforceable input/output token caps. Context-window settings and after-the-fact usage do not impose a total budget on tool-driven model requests. No model turn was submitted. V2-V7 remain unverified; configuration readback is not tool isolation evidence.' })
      value.reasonCode = 'VERIFICATION_BUDGET_UNSUPPORTED'
      value.state = 'inconclusive'
      for (const key of requiredCapabilities.filter(key => !['protocol_handshake', 'effective_profile'].includes(key))) value.capabilities[key] = { status: 'not_run', evidenceIds: [budgetEvidence] }
    } catch {
      value.state = this.aborted ? 'cancelled' : 'inconclusive'
      value.reasonCode = this.aborted ? 'VERIFICATION_CANCELLED' : 'RUNTIME_UNSUPPORTED'
      await this.evidence({ reasonCode: value.reasonCode, modelTurns: 0, result: 'No unobserved capability is treated as passed' })
    } finally {
      clearTimeout(timer)
      try { await this.server?.close() }
      catch { value.state = 'cleanup_uncertain'; value.reasonCode = 'PROCESS_CLEANUP_UNCERTAIN' }
      this.saveProcess(value.state === 'cleanup_uncertain' ? 'cleanup_uncertain' : 'group-closed')
      if (value.state !== 'cleanup_uncertain' && fixture) await rm(fixture, { recursive: true, force: true })
      if (this.aborted && value.state !== 'cleanup_uncertain') { value.state = 'cancelled'; value.reasonCode = 'VERIFICATION_CANCELLED' }
      value.finishedAt = new Date().toISOString(); value.revision++
      this.persist(verificationSchema.parse(value))
    }
    return value
  }
  private saveProcess(state: string) {
    if (!this.server?.child.pid) return
    this.recordProcess({ runId: this.verification.id, pid: this.server.child.pid, epoch: this.server.epoch, startedAt: this.server.startedAt, state, observed: [...(this.server.tracker?.observed.values() ?? [])] })
  }
}
