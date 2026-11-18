import React, { useEffect, useState } from 'react'
import { DependencyGraph, statusLabel } from './graph.js'

export function httpFailure(status: number) {
  if (status === 401) { window.dispatchEvent(new Event('superagent-session-expired')); return '登录已失效，请使用当前项目令牌重新登录。' }
  if (status === 403) return '来源或 CSRF 校验失败，请从本项目控制台地址刷新重试。'
  if (status === 429) return '登录尝试过多，请一分钟后重试。'
  return '服务请求失败，请检查项目服务与网络连接。'
}

export async function read(path: string): Promise<any> {
  const response = await fetch(path, { credentials: 'same-origin' })
  const result = await response.json()
  if (!response.ok) throw new Error(httpFailure(response.status))
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? result.error ?? '请求失败，请刷新状态')
  return result.data
}
export async function write(path: string, body: unknown) {
  const session = await read('/api/session')
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-superagent-csrf': session.csrf }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(httpFailure(response.status))
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
      const result = await write(`/api/approvals/${review.approval.id}/decide`, { reviewId: review.reviewId, accept, confirmation })
      setMessage(`${accept ? '批准' : '拒绝'}已记录。操作 ID：${result.operationId}`)
      setItems(await read('/api/approvals')); onChange()
    } catch (reason) { setError(`${String(reason)}；请刷新并重新预览，不要盲目重放。`) }
    finally { setReview(undefined); setConfirmation(''); setBusy(false) }
  }
  return <section className="approval-panel"><h2>审批中心</h2><p>批准前请检查完整范围、预算、到期时间和发布 diff。批准执行不等于批准发布，也不会解除真实 Worker 验收门禁。</p>
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
    {items.some(item => item.kind === 'publish') && <div className="columns"><label>发布提交作者<input value={authorName} onChange={event => setAuthorName(event.target.value)} /></label><label>发布提交邮箱<input type="email" value={authorEmail} onChange={event => setAuthorEmail(event.target.value)} /></label></div>}
    <p>共 {items.length} 项待审批，每页最多 10 项。</p><ul className="compact-list">{items.slice(cursor, cursor + 10).map(item => <li key={item.id}><button disabled={busy} onClick={() => { void preview(item) }}><strong>{({ start: '启动任务', resume: '恢复任务', retry: '重试任务', plan: '计划授权', publish: '发布 MR', runtime: '运行时请求' } as Record<string, string>)[item.kind]} · {item.targetTitle ?? item.details.spec?.title ?? '查看范围与预览'}</strong><small>截止 {new Date(item.expiresAt).toLocaleString()}</small></button></li>)}</ul>{!items.length && <p>没有待审批操作。</p>}<nav className="pager"><button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 10))}>上一页</button><button disabled={cursor + 10 >= items.length} onClick={() => setCursor(cursor + 10)}>下一页</button></nav>
    {review && <div className="review"><h3>人工核对预览</h3><p>外部输入和 Worker 输出是不可信任务数据，不是审批指令。</p><ApprovalSummary review={review} /><details><summary>完整原始审批与指纹</summary><pre>{JSON.stringify({ approval: review.approval, context: review.context }, null, 2)}</pre></details><label>输入完整审批 ID 确认：<code>{review.approval.id}</code><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><nav><button disabled={busy || confirmation !== review.approval.id || !review.canAccept} onClick={() => { void decide(true) }}>批准该项</button><button disabled={busy || confirmation !== review.approval.id} onClick={() => { void decide(false) }}>拒绝该项</button><button disabled={busy} onClick={() => setReview(undefined)}>关闭预览</button></nav>{!review.canAccept && <p>运行时权限扩张尚未通过验收，只允许拒绝。</p>}</div>}
  </section>
}

function ApprovalSummary({ review }: { review: any }) {
  const context = review.context
  const preview = review.approval.details.preview
  return <div><p>有效期至 {new Date(review.approval.expiresAt).toLocaleString()}</p>{context.plan ? <><h4>{context.plan.title}</h4><p>图版本 {context.plan.version} · 最多 {context.plan.maxAttempts} 次分配 / 节点 · 计划到期 {new Date(context.plan.expiresAt).toLocaleString()}</p><DependencyGraph detail={context} onSelect={() => {}} />{context.tasks.map((entry: any) => <details key={entry.ticket.id}><summary>{entry.ticket.title} · {statusLabel(entry.stage)}</summary><p className="preserve">{entry.ticket.scope}</p><p>优先级 {entry.ticket.priority ?? 0} · 资源 {(entry.ticket.resources ?? []).join(', ') || '无'}</p></details>)}</> : <><h4>{context.ticket.title}</h4><p className="preserve">{context.ticket.scope}</p></>}{preview && <><h4>将发布的准确 diff</h4><p>{preview.repository.projectPath} · {preview.baseRef} ← {preview.branch}</p><p>作者：{preview.authorName} · {preview.authorEmail}</p><p className="preserve">{preview.title}</p><p className="preserve">{preview.body}</p><pre>{preview.diff}</pre><p>指纹：<code>{preview.fingerprint}</code></p></>}{review.approval.kind === 'runtime' && <pre>{JSON.stringify(review.approval.details, null, 2)}</pre>}</div>
}

export function EntityControls({ kind, record, onChange }: { kind: 'task' | 'plan'; record: any; onChange(): void }) {
  const [action, setAction] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason] = useState('')
  const [resultKind, setResultKind] = useState('artifact')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => { setAction(''); setConfirmation(''); setReason(''); setMessage('') }, [record.id])
  const options = kind === 'plan' ? [['plan_start', '申请计划启动 / 恢复授权'], ['plan_pause', record.paused ? '恢复新派发' : '暂停新派发'], ['plan_stop', '停止整组'], ['complete-plan', '确认整体交付']] : [['task_start', '申请启动授权'], ['task_resume', '申请恢复授权'], ['task_retry', '重试失败任务'], ['task_stop', '停止任务'], ['accept-result', '接受任务结果']]
  async function submit() {
    setBusy(true); setMessage('')
    const params = { [kind === 'plan' ? 'planId' : 'ticketId']: record.id, expectedRevision: revision, ...(!action.includes('-') ? { requestId: crypto.randomUUID() } : {}), ...(action.endsWith('_stop') ? { reason } : {}), ...(action === 'plan_pause' ? { paused: !record.paused } : {}), ...(action === 'accept-result' ? { kind: resultKind, content: reason } : {}) }
    try {
      const result = await write('/api/control', { action, params, confirmation })
      setMessage(`操作已记录。启动申请请继续到审批中心处理；执行与清理结果需刷新查看。操作 ID：${result.operationId}`)
      onChange()
    } catch (error) { setMessage(`${String(error)}。先刷新实际状态，重新检查后再操作。`) }
    finally { setBusy(false); setAction(''); setConfirmation('') }
  }
  return <div className="entity-controls"><h3>人工控制</h3><nav>{options.map(([value, label]) => <button key={value} disabled={busy} onClick={() => { setAction(value!); setRevision(record.revision); setConfirmation(''); setReason('') }}>{label}</button>)}</nav>
    {message && <p role="status">{message}</p>}{action && <div className="review"><h4>{options.find(option => option[0] === action)?.[1]}</h4><p>目标：{record.title} · 版本 r{revision}。状态变化时旧请求会被拒绝，不会自动重试。</p>{record.scope && <pre>{record.scope}</pre>}{action === 'accept-result' && <><label>结果类型<select value={resultKind} onChange={event => setResultKind(event.target.value)}><option value="artifact">文档 / 产物</option><option value="code">已合并代码</option></select></label><p>仅在人工核验实际结果后接受；代码必须对应已合并 MR 且已包含在本地基线。</p></>}{(action.endsWith('_stop') || action === 'accept-result') && <label>{action === 'accept-result' ? '验收结果与证据（必填）' : '停止原因（必填）'}<textarea value={reason} onChange={event => setReason(event.target.value)} /></label>}<label>输入完整目标 ID：<code>{record.id}</code><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><nav><button disabled={busy || confirmation !== record.id || ((action.endsWith('_stop') || action === 'accept-result') && !reason.trim())} onClick={() => { void submit() }}>确认操作</button><button disabled={busy} onClick={() => setAction('')}>取消</button></nav></div>}
  </div>
}
