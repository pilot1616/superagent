import React, { useState } from 'react'
import { write } from './controls.js'

const phases: Record<string, string> = { disabled: '未启用', checking: '等待诊断', auth_required: '等待独立认证', verification_required: '等待真实验收', verifying: '验证进行中', ready: '已就绪，待人工启用', enabled: '已启用', degraded: '环境异常，暂停派发', quarantined: '已隔离，需人工核对' }
const reasons: Record<string, string> = { AUTH_REQUIRED: 'Worker 尚未独立登录；网页登录令牌不能代替模型认证。', AUTH_MODE_UNSUPPORTED: '认证方式不受支持，不能借用主会话凭据。', RUNTIME_INSPECTION_STALE: '诊断缺失或过期，请重新诊断。', RUNTIME_UNSUPPORTED: '当前版本、策略或执行后端尚不受支持。', RUNTIME_VERIFICATION_REQUIRED: '缺少匹配当前环境的真实执行证据。', RUNTIME_ENABLEMENT_REQUIRED: '尚未人工启用，或启用已到期。', RUNTIME_FINGERPRINT_CHANGED: '环境已发生变化，旧证据或确认不能继续使用。', RUNTIME_QUARANTINED: '存在未核对执行；先核对任务与进程，再重新验证。', VERIFICATION_BUDGET_UNSUPPORTED: '固定版本无法强制限制验证总 token；尚未提交模型 turn，不能标记验收通过。' }
const warnings: Record<string, string> = { RUNTIME_VERIFICATION_INCOMPLETE: '完整真实验收尚未通过，仅作风险提示，不阻止人工启用或任务派发。', TOKEN_BUDGET_NOT_ENFORCED: '没有可强制执行的总 token 或费用上限；执行会使用所配置的模型账号。' }

export function RuntimePanel({ runtime, repositoryId, onChange }: { runtime: any; repositoryId: string; onChange(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<any>()
  const [action, setAction] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason] = useState('')
  async function execute(operation: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await operation(); onChange() } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }
  const target = () => ({ expectedRevision: runtime.revision, repositoryId })
  async function preview(kind: string) {
    await execute(async () => {
      const path = kind === 'verify' ? 'verification' : kind.startsWith('disable') ? 'disable' : 'enable'
      const result = await write(`/api/runtime/${path}/preview`, target())
      setReview(result.data); setAction(kind); setConfirmation(''); setReason('')
    })
  }
  async function confirm() {
    if (!review || confirmation !== repositoryId) return
    await execute(async () => {
      const base = { requestId: crypto.randomUUID(), expectedRevision: review.expectedRevision, repositoryId, confirmation }
      if (action === 'enable') await write('/api/runtime/enable', { ...base, reviewId: review.reviewId, mode: 'restricted_local', verificationId: review.verificationId, expectedFingerprint: review.expectedFingerprint, reason })
      else if (action === 'verify') await write('/api/runtime/verification/start', { ...base, reviewId: review.reviewId, expectedFingerprint: review.expectedFingerprint, limits: review.detail.limits })
      else await write('/api/runtime/disable', { ...base, reviewId: review.reviewId, mode: action === 'disable-stop' ? 'stop' : 'drain', reason })
      setReview(undefined)
    })
  }
  if (!runtime) return null
  const primaryReason = runtime.reasonCodes?.[0]
  return <section className="surface runtime-section"><div className="section-heading"><h2>Worker 环境 · {phases[runtime.phase] ?? runtime.phase}</h2><span className="badge">受限本机执行</span></div>
    <p>{primaryReason ? reasons[primaryReason] ?? primaryReason : '环境允许派发；仍需任务或计划授权、依赖验收及可用资源。'}</p>
    <p>模型：{runtime.inspection?.model ?? '尚未检查'} · Provider：{runtime.inspection?.provider?.id ?? '未知'} · 最近检查：{runtime.inspection?.checkedAt ?? '无'}{runtime.enablement && ` · 人工启用到期：${runtime.enablement.expiresAt}`}</p>
    <p>沙箱外权限、工具网络和 GitLab 发布不随环境启用而开放。</p>
    <p>Worker 内子 Agent：{runtime.inspection?.agents?.enabled ? `已开启 · 每个 Worker 最多 ${runtime.inspection.agents.maxConcurrent} 个并发子 Agent · 深度 1 · 共享任务工作区；会增加模型调用。` : '未开启（旧 profile 不自动升级）'}</p>
    <p>完整验收是可选诊断，不再是 Worker 启动门槛。</p>
    {runtime.warningCodes?.length > 0 && <ul aria-label="非阻塞运行提示">{runtime.warningCodes.map((code: string) => <li key={code}>{warnings[code] ?? code}</li>)}</ul>}
    {error && <p role="alert" className="error">{error}</p>}
    <nav><button disabled={busy} onClick={() => { void execute(async () => { await write('/api/runtime/check', {}); setReview(undefined) }) }}>重新诊断（不调用模型）</button><button disabled={busy || !runtime.fingerprint || runtime.phase === 'verifying' || runtime.phase === 'quarantined'} onClick={() => { void preview('verify') }}>验证预览</button><button disabled={busy || runtime.phase !== 'ready'} onClick={() => { void preview('enable') }}>预览并启用</button><button disabled={busy} onClick={() => { void preview('disable-drain') }}>停止新派发</button><button disabled={busy} onClick={() => { void preview('disable-stop') }}>停止运行中任务</button></nav>
    {runtime.phase === 'auth_required' && <details><summary>独立登录步骤</summary><p>{runtime.loginInstructions}</p><p>认证由用户在可信终端完成；请勿在网页、聊天或任务内容中粘贴模型凭据。</p></details>}
    {review && <p>Worker 并发上限 {review.concurrency} · 含主/子 Agent 的潜在会话上限 {review.maxAgentSessions ?? review.concurrency}；这不是费用上限。</p>}
    {runtime.verification && <details><summary>最近验证：{runtime.verification.state} · {reasons[runtime.verification.reasonCode] ?? runtime.verification.reasonCode ?? '查看逐项证据'}</summary><p>未运行、不确定、普通测试通过均不是真实验收通过。</p><pre>{JSON.stringify(runtime.verification, null, 2)}</pre></details>}
    {review && <div className="review"><h3>确认{action === 'enable' ? '启用 Worker' : action === 'verify' ? '验证预算与限制' : action === 'disable-stop' ? '停止当前任务' : '停止新派发'}</h3><p>项目：<code>{repositoryId}</code> · 并发上限 {review.concurrency}</p><p>已获任务授权、启用后可能启动：{review.queued.map((task: any) => task.title).join('、') || '无'}；运行中：{review.affectedTasks.map((task: any) => task.title).join('、') || '无'}</p>{action === 'enable' && <ul>{review.warningCodes?.map((code: string) => <li key={code}>{warnings[code] ?? code}</li>)}</ul>}{action === 'verify' && <p role="alert">{review.detail.limitation} 费用上限未知，不保证真实模型套件可运行。</p>}<details><summary>完整指纹、预算与验证场景</summary><pre>{JSON.stringify(review, null, 2)}</pre></details><label>输入当前项目 ID 确认<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>{action !== 'verify' && <label>操作原因<input value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} /></label>}<button disabled={busy || confirmation !== repositoryId || (action !== 'verify' && !reason.trim())} onClick={() => { void confirm() }}>确认执行此操作</button><button disabled={busy} onClick={() => setReview(undefined)}>取消</button></div>}
    <details><summary>环境证据与全部阻塞原因</summary><ul>{runtime.reasonCodes?.map((code: string) => <li key={code}>{reasons[code] ?? code}</li>)}</ul><pre>{JSON.stringify(runtime.inspection, null, 2)}</pre></details>
  </section>
}

export function RuntimeQuestion({ approval, repositoryId, onChange }: { approval: any; repositoryId: string; onChange(): void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const questions = approval.details.params.questions
  async function answer() {
    if (busy) return
    setBusy(true); setError('')
    try { await write(`/api/runtime/input/${approval.id}/answer`, { id: approval.id, requestId: crypto.randomUUID(), repositoryId, expectedRevision: approval.revision, confirmation, answers: Object.fromEntries(questions.map((question: any) => [question.id, { answers: [answers[question.id]] }])) }); onChange() } catch (failure) { setError(String(failure)) } finally { setBusy(false) }
  }
  return <article className="surface"><h3>Worker 澄清问题 · {approval.targetTitle}</h3><p>回答只继续当前请求，不授予任何权限；不要输入密钥。请求 ID：<code>{approval.id}</code></p>{questions.map((question: any) => <label key={question.id}>{question.question}<textarea maxLength={10000} value={answers[question.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} /></label>)}<label>输入请求 ID 确认<input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button disabled={busy || confirmation !== approval.id || questions.some((question: any) => !answers[question.id]?.trim())} onClick={() => { void answer() }}>发送回答</button>{error && <p role="alert" className="error">{error}</p>}</article>
}
