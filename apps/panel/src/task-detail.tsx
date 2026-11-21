import React, { useEffect, useState } from 'react'
import { EntityControls, read, write } from './controls.js'
import { taskStatus, statusLabel } from './graph.js'
import { DeletionControl } from './deletion.js'
import { TaskWorkspace } from './workspace.js'

function CheckpointCard({ entry, ticket }: { entry: any; ticket: any }) {
  const generation = ticket.assignments.find((assignment: any) => assignment.id === entry.assignmentId)?.generation
  const state = entry.state === 'ready' ? '本地结果就绪' : entry.state ? statusLabel(entry.state) : ''
  return <li><div><span className="badge">{entry.historical && '历史 · '}{entry.kind === 'report' ? '本轮结论' : entry.kind === 'system' ? '执行状态记录' : '执行中进展'} · 非验收凭据</span><small>{new Date(entry.createdAt).toLocaleString()} · 第 {generation ?? '—'} 轮 {state && `· ${state}`}</small></div><p className="preserve">{entry.summary}</p>{entry.checks?.length > 0 && <ul>{entry.checks.map((check: string, index: number) => <li key={index}>{check}</li>)}</ul>}{entry.question && <p>待澄清：{entry.question}</p>}{entry.historical && <details><summary>本条对应调整前的范围或计划版本</summary><p className="preserve">{entry.scope}</p></details>}</li>
}

function TaskMaterials({ ticket, onChange }: { ticket: any; onChange(): void }) {
  const [files, setFiles] = useState<any[]>([])
  const [paths, setPaths] = useState('')
  const [preview, setPreview] = useState<any>()
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let disposed = false
    void read(`/api/tasks/${ticket.id}/materials`).then(value => { if (!disposed) setFiles(value.files) }).catch(reason => { if (!disposed) setError(String(reason)) })
    setPreview(undefined); setConfirmation('')
    return () => { disposed = true }
  }, [ticket.id, ticket.revision])
  async function submit(attach: boolean) {
    setBusy(true); setError('')
    try {
      const params = attach ? { ticketId: ticket.id, expectedRevision: preview.revision, previewId: preview.id, confirmation, requestId: crypto.randomUUID() } : { ticketId: ticket.id, expectedRevision: ticket.revision, paths: paths.split('\n').map(path => path.trim()).filter(Boolean) }
      const value = await write(`/api/tasks/${ticket.id}/materials/${attach ? 'attach' : 'preview'}`, params)
      if (attach) { setPreview(undefined); setPaths(''); setConfirmation(''); setFiles(value.files); onChange() } else setPreview(value)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <details><summary>只读参考资料 · {files.length} 个</summary><p>新计划的共享资料随目标确认自动分发，无需逐任务上传。此处仅用于手动补充：运行或待派发任务需先停止；资料不会扩大执行授权。</p>{files.map(file => <p key={file.id}>{file.name} · {file.bytes} 字节 · SHA-256 <code>{file.sha256}</code></p>)}<label>本地文件绝对路径，每行一个，最多 10 个<textarea value={paths} onChange={event => { setPaths(event.target.value); setPreview(undefined) }} /></label><button disabled={busy || !paths.trim()} onClick={() => { void submit(false) }}>预览资料</button>{preview && <div className="review"><h4>核对资料内容摘要</h4>{preview.files.map((file: any) => <p key={file.source}>{file.source} · {file.bytes} 字节 · SHA-256 <code>{file.sha256}</code></p>)}<label>输入完整任务 ID <code>{ticket.id}</code><input value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button disabled={busy || confirmation !== ticket.id} onClick={() => { void submit(true) }}>确认附加只读快照</button></div>}{error && <p role="alert" className="error">{error}</p>}</details>
}

function TaskEditor({ detail, onChange }: { detail: any; onChange(): void }) {
  const [editing, setEditing] = useState<any>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  function begin(mode: string) {
    const ticket = detail.ticket
    setEditing({ mode, revision: ticket.revision, planRevision: detail.planRevision, title: ticket.title, scope: ticket.scope, priority: ticket.priority ?? 0, resources: (ticket.resources ?? []).join(', '), reason: '', text: '', confirmation: ticket.id })
    setMessage('')
  }
  const set = (key: string, value: unknown) => setEditing((current: any) => ({ ...current, [key]: value }))
  async function submit() {
    setBusy(true)
    const params = { ticketId: detail.ticket.id, expectedRevision: editing.revision, requestId: crypto.randomUUID(), ...(editing.mode === 'message' ? { text: editing.text } : { expectedPlanRevision: editing.planRevision, title: editing.title, scope: editing.scope, priority: editing.priority, resources: editing.resources.split(',').map((value: string) => value.trim()).filter(Boolean), reason: editing.reason }) }
    try {
      const result = await write('/api/control', { action: editing.mode === 'message' ? 'task_message' : 'task_adjust', params, confirmation: editing.confirmation })
      setMessage(`${editing.mode === 'message' ? '说明已保存，待下一轮消费；当前执行不会被即时改写。' : '已暂停并保存新范围。等待清理完成后，在目标控制中确认新范围并恢复。'} 操作 ID：${result.operationId}`)
      setEditing(undefined); onChange()
    } catch (error) { setMessage(`${String(error)}。请刷新并重新核对版本，不要盲目重试。`) }
    finally { setBusy(false) }
  }
  return <section className="task-editor"><h3>执行中调整</h3><nav><button disabled={busy || !!detail.ticket.result || detail.ticket.ended === 'completed'} onClick={() => begin('message')}>追加说明</button><button disabled={busy || !!detail.ticket.result || detail.ticket.ended === 'completed'} onClick={() => begin('adjust')}>暂停并调整范围</button></nav>{message && <p role="status">{message}</p>}
    {editing && <div className="review"><p>已核对版本 r{editing.revision}；状态变化后请求会被拒绝，不会自动重试。</p>{editing.mode === 'message' ? <><p>不会解除人工停止；新说明在下一轮执行时消费。扩大范围请使用“暂停并调整范围”。</p><label>补充说明<textarea value={editing.text} onChange={event => set('text', event.target.value)} /></label></> : <>
      <p className="notice">{detail.ticket.planId ? '将停止整组、撤销计划授权；未验收节点的旧报告仅保留为历史，重新审批后重新执行。' : '将停止当前执行并撤销授权，重新审批后使用新会话执行。'} 已有工作目录和编辑保留，尝试预算不增加，已验收结果不可改写。</p>
      <label>任务名称<input value={editing.title} onChange={event => set('title', event.target.value)} /></label><label>完整新范围<textarea value={editing.scope} onChange={event => set('scope', event.target.value)} /></label><label>调整原因<input value={editing.reason} onChange={event => set('reason', event.target.value)} /></label><div className="form-grid"><label>优先级（0–10）<input type="number" min="0" max="10" value={editing.priority} onChange={event => set('priority', Number(event.target.value))} /></label><label>互斥资源（英文逗号分隔）<input value={editing.resources} onChange={event => set('resources', event.target.value)} /></label></div>
    </>}<nav><button disabled={busy || editing.confirmation !== detail.ticket.id || (editing.mode === 'message' ? !editing.text.trim() : !editing.scope.trim() || !editing.title.trim() || !editing.reason.trim())} onClick={() => { void submit() }}>确认{editing.mode === 'message' ? '追加' : '暂停并调整'}</button><button disabled={busy} onClick={() => setEditing(undefined)}>取消</button></nav></div>}
  </section>
}

export function TaskDetail({ ticketId, refreshVersion, onChange, onClose }: { ticketId: string; refreshVersion: number; onChange(): void; onClose(): void }) {
  const [detail, setDetail] = useState<any>()
  const [error, setError] = useState('')
  const [checkpointCursor, setCheckpointCursor] = useState(0)
  const [eventCursor, setEventCursor] = useState(0)
  useEffect(() => {
    let disposed = false
    const refresh = async () => { try { const result = await read(`/api/tasks/${ticketId}?cursor=${eventCursor}&checkpointCursor=${checkpointCursor}`); if (!disposed) { setDetail(result); setError('') } } catch (reason) { if (!disposed) setError(String(reason)) } }
    void refresh(); const interval = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [ticketId, eventCursor, checkpointCursor, refreshVersion])
  return <section className="task-detail"><div className="section-heading"><h2>任务详情</h2><button onClick={onClose}>关闭详情</button></div>{error && <p role="alert" className="error">{error}</p>}{detail && <>
    <h3>{detail.ticket.title} <span className="badge">{taskStatus(detail)}</span></h3><p className="preserve">{detail.ticket.scope}</p>{detail.scheduling.reasons.length > 0 && <p className="notice">{detail.scheduling.reasons.join('；')}</p>}
    {(detail.ticket.failure || detail.ticket.reconciliation) && <p className="error">{detail.ticket.failure ?? detail.ticket.reconciliation}</p>}
    {detail.ticket.report?.question && <p className="notice">需要回答：{detail.ticket.report.question}</p>}
    {detail.ticket.restartThread && <p className="notice">任务或计划已调整。旧阶段结论仅作历史；新范围需重新授权，清理完成后使用新的执行会话。</p>}
    {detail.ticket.result && <article><h3>{detail.ticket.result.acceptedBy === 'coordinator' ? '系统已交接（非人工验收）' : '人工已验收结论'}</h3><p className="preserve">{detail.ticket.result.content}</p></article>}
    <details open={detail.agents?.some((agent: any) => !agent.historical && !agent.cleanup)}><summary>Worker 子 Agent · {detail.agents?.length ?? 0} 个（最多显示最近 64 条）</summary><p>共享本任务 worktree；子 Agent 结论不是任务验收。停止任务会统一停止整个 Worker。</p>{detail.agents?.map((agent: any) => <article key={agent.id}><strong>{agent.historical && '历史 · '}{agent.nickname ?? agent.role ?? agent.threadId}</strong><p>父线程：<code>{agent.parentThreadId}</code> · 状态：{agent.status} · 清理：{agent.cleanup ?? '尚未确认关闭'}</p>{agent.scope && <p className="preserve">分工：{agent.scope}</p>}{agent.progress && <p className="preserve">进展：{agent.progress}</p>}{agent.summary && <p className="preserve">结论（未验收）：{agent.summary}</p>}</article>)}</details>
    <h3>阶段性结论 <small>进展和本轮报告不等于人工验收</small></h3>
    <ol className="timeline">{detail.checkpoints.map((entry: any) => <CheckpointCard key={entry.id} entry={entry} ticket={detail.ticket} />)}</ol>
    {!detail.checkpoints.length && <p className="preserve">{detail.ticket.report?.summary ?? '尚无 Worker 阶段结论；门禁阻塞、排队或未执行不代表已完成。'}</p>}
    <nav><button disabled={!checkpointCursor} onClick={() => setCheckpointCursor(Math.max(0, checkpointCursor - 20))}>较新结论</button><span>共 {detail.checkpointTotal} 条</span><button disabled={detail.nextCheckpointCursor === null} onClick={() => setCheckpointCursor(detail.nextCheckpointCursor)}>较早结论</button></nav>
    <TaskWorkspace detail={detail} onChange={onChange} /><TaskMaterials ticket={detail.ticket} onChange={onChange} /><TaskEditor detail={detail} onChange={onChange} /><details><summary>任务控制与验收</summary><EntityControls kind="task" record={detail.ticket} detail={detail} retryBudget={detail.retryBudget} onChange={onChange} /></details>
    <DeletionControl kind="task" record={detail.ticket} onDeleted={() => { onClose(); onChange() }} />
    <details><summary>待消费说明 · {detail.ticket.inputs.filter((entry: any) => entry.state === 'pending').length} 条</summary>{detail.ticket.inputs.filter((entry: any) => entry.state === 'pending').map((entry: any) => <p key={entry.id} className="preserve">{entry.text}</p>)}</details>
    <details><summary>输入、执行记录与审计</summary><pre>{JSON.stringify({ id: detail.ticket.id, revision: detail.ticket.revision, inputs: detail.ticket.inputs, assignments: detail.ticket.assignments, binding: detail.ticket.binding, approvals: detail.approvals, events: detail.events }, null, 2)}</pre><nav><button disabled={!eventCursor} onClick={() => setEventCursor(0)}>首批事件</button><button disabled={detail.events.length < 50} onClick={() => setEventCursor(detail.events.at(-1).sequence)}>后续事件</button></nav></details>
  </>}</section>
}
