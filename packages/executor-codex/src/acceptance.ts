import { requiredCapabilities, type RuntimeSnapshot } from './contracts.js'

export function evaluateRuntime(snapshot?: RuntimeSnapshot, now = Date.now()) {
  const { state, inspection, verification, enablement } = snapshot ?? {}
  const reasons: string[] = []
  let phase = 'disabled'
  if (!inspection || Date.parse(inspection.validUntil) <= now) { reasons.push('RUNTIME_INSPECTION_STALE'); phase = 'checking' }
  if (state?.inspectionFailure) { reasons.unshift(state.inspectionFailure.reasonCode); phase = 'degraded' }
  if (inspection) {
    if (inspection.repositoryId !== state?.repositoryId) reasons.push('RUNTIME_FINGERPRINT_CHANGED')
    for (const check of inspection.checks) if (check.status === 'failed' || check.status === 'unknown') reasons.push(check.reasonCode ?? 'RUNTIME_UNSUPPORTED')
    if (inspection.auth.status !== 'configured') { reasons.push(inspection.auth.status === 'missing' ? 'AUTH_REQUIRED' : 'AUTH_MODE_UNSUPPORTED'); phase = 'auth_required' }
    else if (reasons.length) phase = 'degraded'
  }
  const verified = !!verification && verification.state === 'passed' && verification.repositoryId === state?.repositoryId && verification.mode === state?.mode && verification.fingerprint === inspection?.fingerprint && !!verification.validUntil && Date.parse(verification.validUntil) > now && snapshot?.verificationEvidenceValid !== false && requiredCapabilities.every(key => verification.capabilities[key]?.status === 'passed' && verification.capabilities[key]!.evidenceIds.length > 0)
  const enabled = !!enablement && enablement.repositoryId === state?.repositoryId && enablement.mode === state?.mode && enablement.status === 'active' && enablement.daemonEpoch === snapshot?.daemonEpoch && enablement.fingerprint === inspection?.fingerprint && Date.parse(enablement.expiresAt) > now
  if (!enabled) { reasons.push('RUNTIME_ENABLEMENT_REQUIRED'); if (reasons.length === 1) phase = 'ready' }
  if (state?.verificationRunId) { reasons.push('RUNTIME_VERIFICATION_RUNNING'); phase = 'verifying' }
  if (state?.quarantine) { reasons.unshift('RUNTIME_QUARANTINED'); phase = 'quarantined' }
  const reasonCodes = [...new Set(reasons)]
  const canDispatch = reasonCodes.length === 0
  if (canDispatch) phase = 'enabled'
  const warningCodes = [...(verified ? [] : ['RUNTIME_VERIFICATION_INCOMPLETE']), 'TOKEN_BUDGET_NOT_ENFORCED']
  return { mode: 'restricted_local' as const, phase, revision: state?.revision ?? 0, fence: state?.fence ?? 0, canDispatch, fingerprint: inspection?.fingerprint, reasonCodes, warningCodes, verificationRequired: false, verificationPassed: verified, checks: inspection?.checks ?? [], capabilities: { restrictedExecution: canDispatch, runtimeEscalation: false, toolNetworkGrant: false }, inspection, verification, enablement }
}

export const executionVerified = (snapshot?: RuntimeSnapshot): boolean => evaluateRuntime(snapshot).verificationPassed
export function runtimeReadiness(snapshot?: RuntimeSnapshot | boolean) {
  const runtime = evaluateRuntime(typeof snapshot === 'object' ? snapshot : undefined)
  const checks = runtime.checks.length ? runtime.checks.map(check => ({ key: check.key, title: check.key, passed: check.status === 'passed', blocking: true, next: check.nextAction ?? check.reasonCode })) : [{ key: 'version', title: 'Codex 版本诊断', passed: false, blocking: true, next: '运行 runtime check 获取当前诊断' }]
  for (const key of requiredCapabilities) checks.push({ key: `verification:${key}`, title: key, passed: runtime.verificationPassed && runtime.verification?.capabilities[key]?.status === 'passed', blocking: false, next: '可选验收记录，不阻止启用或派发；未运行不是通过。' })
  return { enabled: runtime.canDispatch, summary: runtime.canDispatch ? 'Worker 已启用' : `Worker 暂不派发：${runtime.reasonCodes.join('、')}`, checks, warningCodes: runtime.warningCodes, inspectionCommand: 'superagent-local runtime check --state <该项目 state>', note: '完整验收不再是派发门槛；仍需环境诊断、人工启用和任务授权。总 token 预算不保证；沙箱外权限与工具网络仍关闭。' }
}
