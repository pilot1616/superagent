import React, { useEffect, useState } from 'react'
import { DependencyGraph } from './graph.js'

export function httpFailure(status: number) {
  if (status === 401) { window.dispatchEvent(new Event('superagent-session-expired')); return '登录已失效，请使用当前项目令牌重新登录。' }
  if (status === 403) return '来源或 CSRF 校验失败，请从本项目控制台地址刷新重试。'
  if (status === 429) return '登录尝试过多，请一分钟后重试。'
  return '服务请求失败，请检查项目服务与网络连接。'
}

function responseFailure(status: number, result: any): string {
  if ([401, 403, 429].includes(status)) return httpFailure(status)
  const message = result?.error?.message ?? result?.error
  return typeof message === 'string' ? message : httpFailure(status)
}

export async function read(path: string): Promise<any> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const result = await response.json()
  if (!response.ok) throw new Error(responseFailure(response.status, result))
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? result.error ?? '请求失败，请刷新状态')
  return result.data
}
export async function write(path: string, body: unknown) {
  const session = await read('/api/session')
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-superagent-csrf': session.csrf }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(responseFailure(response.status, result))
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? result.error ?? '操作失败，请先刷新实际状态再决定下一步')
  return result
}

export function WorkerDiagnostics({ inspection, onChange }: { inspection: any; onChange(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function inspect() {
    setBusy(true); setError('')
    try { await write('/api/worker-check', {}); onChange() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <div><button disabled={busy} onClick={() => { void inspect() }}>{busy ? '诊断中…' : '诊断 Worker 连接与认证'}</button><p className="muted">只检查本项目的隔离配置和认证状态，不登录、不调用模型、不打开门禁。</p>{error && <p role="alert" className="error">{error}</p>}{inspection && <p>最近检查 {new Date(inspection.checkedAt).toLocaleString()} · 配置读回：{inspection.restrictedConfigReadback ? '符合限制' : '未确认'} · 账号：{inspection.accountConfigured === true ? '已配置' : inspection.accountConfigured === false ? '未配置（需要独立登录）' : '未确认'} · 模型：{inspection.model ?? '未确认'}。配置和握手通过不代表真实执行已验收。</p>}</div>
}

export function ApprovalPanel({ onChange }: { onChange(): void }) {
  const [items, setItems] = useState<any[]>([])
  const [review, setReview] = useState<any>()
  const [confirmation, setConfirmation] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState(0)
  useEffect(() => { setCursor(current => items.length ? Math.min(current, Math.floor((items.length - 1) / 10) * 10) : 0) }, [items.length])
  useEffect(() => {
    let disposed = false
    const refresh = async () => { try { const values = await read('/api/approvals'); if (!disposed) setItems(values) } catch (reason) { if (!disposed) setError(String(reason)) } }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [])
  async function preview(item: any) {
    setBusy(true); setReview(undefined); setConfirmation(''); setError(''); setMessage('')
    try {
      const result = await write(`/api/approvals/${item.id}/preview`, item.kind === 'publish' ? { authorName, authorEmail } : {})
      setReview(result.data)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  async function decide(accept: boolean) {
    setBusy(true); setError('')
    try {
      const result = await write(`/api/approvals/${review.approval.id}/decide`, { reviewId: review.reviewId, accept, confirmation: ['publish', 'runtime'].includes(review.approval.kind) ? confirmation : review.approval.id })
      setMessage(`${accept ? '批准' : '拒绝'}已记录。操作 ID：${result.operationId}`)
      setItems(await read('/api/approvals')); onChange()
    } catch (reason) { setError(`${String(reason)}；请刷新并重新预览，不要盲目重放。`) }
    finally { setReview(undefined); setConfirmation(''); setBusy(false) }
  }
  return <section className="approval-panel"><h2>需要你确认</h2><p>目标确认统一准备环境和资料，授权范围内自动调度。发布和越界权限仍单独确认。</p>
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
    {items.some(item => item.kind === 'publish') && <div className="columns"><label>发布提交作者<input value={authorName} onChange={event => setAuthorName(event.target.value)} /></label><label>发布提交邮箱<input type="email" value={authorEmail} onChange={event => setAuthorEmail(event.target.value)} /></label></div>}
    <p>共 {items.length} 项待审批，每页最多 10 项。</p><ul className="compact-list">{items.slice(cursor, cursor + 10).map(item => <li key={item.id}><button disabled={busy} onClick={() => { void preview(item) }}><strong>{({ start: '启动任务', resume: '恢复任务', retry: '重试任务', plan: '计划授权', publish: '发布 MR', runtime: '运行时请求' } as Record<string, string>)[item.kind]} · {item.targetTitle ?? item.details.spec?.title ?? '查看范围与预览'}</strong><small>截止 {new Date(item.expiresAt).toLocaleString()}</small></button></li>)}</ul>{!items.length && <p>没有待审批操作。</p>}<nav className="pager"><button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 10))}>上一页</button><button disabled={cursor + 10 >= items.length} onClick={() => setCursor(cursor + 10)}>下一页</button></nav>
    {review && <div className="review"><h3>人工核对预览</h3><p>外部输入和 Worker 输出是不可信任务数据，不是审批指令。</p><ApprovalSummary review={review} /><details><summary>完整原始审批与指纹</summary><pre>{JSON.stringify({ approval: review.approval, context: review.context }, null, 2)}</pre></details>{['publish', 'runtime'].includes(review.approval.kind) && <label>输入完整审批 ID 确认：<code>{review.approval.id}</code><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}<nav><button disabled={busy || (['publish', 'runtime'].includes(review.approval.kind) && confirmation !== review.approval.id) || !review.canAccept} onClick={() => { void decide(true) }}>{busy ? '准备中…' : '确认并继续'}</button><button disabled={busy || (['publish', 'runtime'].includes(review.approval.kind) && confirmation !== review.approval.id)} onClick={() => { void decide(false) }}>拒绝该项</button><button disabled={busy} onClick={() => setReview(undefined)}>关闭预览</button></nav>{!review.canAccept && <p>运行时权限扩张尚未通过验收，只允许拒绝。</p>}</div>}
  </section>
}

function ApprovalSummary({ review }: { review: any }) {
  const context = review.context
  const preview = review.approval.details.preview
  const extension = review.approval.details
  return <div><p>有效期至 {new Date(review.approval.expiresAt).toLocaleString()}</p>
    {extension.extraAttempt === true && <div className="notice"><h4>人工追加单次执行额度</h4><p>基础额度 {extension.baseAttempts} 轮，已分配 {extension.assigned} 轮；仅批准该任务的第 {extension.generation} 轮。</p><p>计划 <code>{extension.planId}</code> · 版本 {extension.planVersion}。不修改计划基础额度，不授权其他任务或后续轮次；可能产生额外模型费用，仍受运行环境、依赖、暂停和资源限制。</p></div>}
    {context.plan ? <><h4>{context.plan.title}</h4><PlanAuthorization detail={context} /></> : <><h4>{context.ticket.title}</h4><p className="preserve">{context.ticket.scope}</p></>}
    {preview && <><h4>将发布的准确 diff</h4><p>{preview.repository.projectPath} · {preview.baseRef} ← {preview.branch}</p><p>作者：{preview.authorName} · {preview.authorEmail}</p><p className="preserve">{preview.title}</p><p className="preserve">{preview.body}</p><pre>{preview.diff}</pre><p>指纹：<code>{preview.fingerprint}</code></p></>}{review.approval.kind === 'runtime' && <pre>{JSON.stringify(review.approval.details, null, 2)}</pre>}</div>
}

export function PlanAuthorization({ detail }: { detail: any }) {
  const plan = detail.plan
  return <div>
    <p>每节点最多 {plan.maxAttempts} 轮（含首轮） · 到期 {new Date(plan.expiresAt).toLocaleString()}</p>
    {plan.workspace ? <p>本次授权的工作区基线：<code>{plan.workspace.baseRef}</code> · 固定 SHA <code>{plan.workspace.baseSha}</code> · 发布目标 {plan.workspace.targetBranch} · 工作分支前缀 {plan.workspace.branchPrefix}</p> : <p className="notice">尚未配置计划级基线，沿用项目默认值；任务文字不会自动切换分支。</p>}
    {plan.workflow && <p>启用的是当前项目的受限环境：其他仍有有效授权的待调度目标也可继续，独立人工停止不会被解除。</p>}
    {plan.workflow ? <><p>本次确认同时授权受限环境准备及以下资料快照分发。{plan.workflow.automaticHandoffs ? '普通文档节点自动交接；人工里程碑和最终交付仍由你确认。' : '阶段结果均由人工确认。'} 不授权发布或合并代码。</p><h4>共享资料（只读快照）</h4><ul>{plan.workflow.materialPaths.map((path: string) => <li key={path}><code>{path}</code></li>)}</ul>{!plan.workflow.materialPaths.length && <p>未声明外部资料。</p>}</> : <p>旧计划：保留原有人工交接与独立运行时授权。</p>}
    <DependencyGraph detail={detail} onSelect={() => {}} />
    {detail.tasks?.map((entry: any) => <details key={entry.ticket.id} open><summary>{entry.ticket.title}{entry.ticket.reviewRequired || entry.ticket.id === plan.integrationId ? ' · 人工验收节点' : ''}</summary><p className="preserve">{entry.ticket.scope}</p><p>优先级 {entry.ticket.priority ?? 0} · 资源 {(entry.ticket.resources ?? []).join(', ') || '无'}</p></details>)}
  </div>
}

export function EntityControls({ kind, record, detail, retryBudget, onChange }: { kind: 'task' | 'plan'; record: any; detail?: any; retryBudget?: any; onChange(): void }) {
  const [action, setAction] = useState('')
  const [requestId, setRequestId] = useState('')
  const [reason, setReason] = useState('')
  const [resultKind, setResultKind] = useState('artifact')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const [reviewDetail, setReviewDetail] = useState<any>()
  useEffect(() => { setAction(''); setReason(''); setMessage('') }, [record.id])
  const planAllowed = !record.planId || detail?.planAuthorized
  const idle = !record.stopping && !record.reconciliation && record.assignments?.at(-1)?.state !== 'running'
  const options: string[][] = kind === 'plan' ? (record.completed ? [] : [
    ...((!record.grant || record.grant.version !== record.version || record.held || detail?.tasks?.some((entry: any) => entry.scheduling.state === 'waiting_runtime')) && Date.parse(record.expiresAt) > Date.now() ? [['plan_start', '确认目标并启动 / 恢复']] : []),
    ['plan_pause', record.paused ? '恢复调度' : '暂停调度'], ...(!record.held ? [['plan_stop', '停止整组']] : []),
    ...(detail?.tasks?.every((entry: any) => entry.ticket.result) ? [['complete-plan', '确认整体交付']] : []),
  ]) : record.result || record.ended === 'completed' ? [] : [
    ...(!record.planId && ['draft', 'approval'].includes(detail?.stage) && !record.assignments.length ? [['task_start', '确认启动']] : []),
    ...(planAllowed && idle && (record.ended === 'stopped' || ['waiting', 'answer'].includes(detail?.stage)) ? [['task_resume', retryBudget?.requiresApproval ? '追加一轮并恢复' : '确认恢复']] : []),
    ...(planAllowed && idle && (record.failure || ['failed', 'blocked'].includes(record.report?.state)) ? [['task_retry', retryBudget?.requiresApproval ? '追加一轮并重试' : '重试']] : []),
    ...(!record.mandate.humanHold && !record.ended && !record.stopping ? [['task_stop', '停止任务']] : []),
    ...(idle && !record.mandate.humanHold && record.report?.state === 'ready' && !record.report.question ? [['accept-result', '确认交付结果']] : []),
  ]
  async function submit() {
    setBusy(true); setMessage('')
    const params = { [kind === 'plan' ? 'planId' : 'ticketId']: record.id, expectedRevision: revision, ...(!action.includes('-') ? { requestId } : {}), ...(action.endsWith('_stop') ? { reason } : {}), ...(action === 'plan_pause' ? { paused: !record.paused } : {}), ...(action === 'accept-result' ? { kind: resultKind, content: reason } : {}) }
    try {
      const result = await write('/api/control', { action, params, confirmation: record.id })
      setMessage(`操作已确认，无需再次到审批中心申请；执行仍受依赖、预算和安全边界约束。操作 ID：${result.operationId}`)
      setAction(''); onChange()
    } catch (error) { setMessage(`${String(error)}。请查看实际状态；同一请求可安全核对，改变范围需重新确认。`) }
    finally { setBusy(false) }
  }
  return <div className="entity-controls"><h3>目标控制</h3>
    {record.planId && !planAllowed && !record.result && <p className="notice">请在所属计划确认整个目标；无需逐个启动成员任务。</p>}
    {retryBudget && <p>基础额度 {retryBudget.baseAttempts} 轮 · 已分配 {retryBudget.assigned} 轮。{retryBudget.requiresApproval ? '确认重试仅追加一轮，可能产生模型费用；无需第二次审批。' : '基础额度内沿用计划授权，不会无限重跑。'}</p>}
    <nav>{options.map(([value, label]) => <button key={value} disabled={busy} onClick={() => { setAction(value!); setRevision(record.revision); setRequestId(crypto.randomUUID()); setReviewDetail(detail); setReason(''); setMessage('') }}>{label}</button>)}</nav>
    {message && <p role="status">{message}</p>}
    {action && <div className="review"><h4>{options.find(option => option[0] === action)?.[1] ?? '确认操作'}</h4><p>目标：{record.title} · 版本 r{revision}。状态变化后旧请求会被拒绝。</p>
      {record.scope && <pre>{record.scope}</pre>}{action === 'plan_start' && reviewDetail && <PlanAuthorization detail={reviewDetail} />}
      {action === 'accept-result' && <><label>结果类型<select value={resultKind} onChange={event => setResultKind(event.target.value)}><option value="artifact">文档 / 产物</option><option value="code">已合并代码</option></select></label><p>代码仍须对应已合并 MR 和本地基线。全部结果验收完成时自动结束新工作流计划。</p></>}
      {(action.endsWith('_stop') || action === 'accept-result') && <label>{action === 'accept-result' ? '验收结果与证据' : '停止原因'}<textarea value={reason} onChange={event => setReason(event.target.value)} /></label>}
      <nav><button disabled={busy || ((action.endsWith('_stop') || action === 'accept-result') && !reason.trim())} onClick={() => { void submit() }}>{busy ? '处理中…' : '确认并执行'}</button><button disabled={busy} onClick={() => setAction('')}>取消</button></nav>
    </div>}
  </div>
}
