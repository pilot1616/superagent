import React, { useEffect, useState } from 'react'
import { write } from './controls.js'

interface Review { id: string; title: string; expectedRevision: number; requestId: string; tasks: { ticketId: string; title: string; expectedRevision: number }[] }

export function DeletionControl({ kind, record, tasks, onDeleted }: { kind: 'task' | 'plan'; record: any; tasks?: any[]; onDeleted(): void }) {
  const [review, setReview] = useState<Review>()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setReview(undefined); setConfirmation(''); setError('') }, [record.id])
  const members = kind === 'plan' ? tasks?.map(entry => entry.ticket) ?? [] : [record]
  const blocked = members.some(ticket => ticket.stopping || ticket.reconciliation || ticket.assignments.some((assignment: any) => assignment.state !== 'ended'))
  const label = kind === 'plan' ? '删除整组计划' : '删除任务'
  function preview() {
    setReview({ id: record.id, title: record.title, expectedRevision: record.revision, requestId: crypto.randomUUID(), tasks: members.map(ticket => ({ ticketId: ticket.id, title: ticket.title, expectedRevision: ticket.revision })) })
    setConfirmation(''); setError('')
  }
  async function submit() {
    if (!review || confirmation !== '删除' || busy) return
    setBusy(true); setError('')
    const params = { requestId: review.requestId, expectedRevision: review.expectedRevision, ...(kind === 'plan' ? { planId: review.id, tasks: review.tasks.map(({ ticketId, expectedRevision }) => ({ ticketId, expectedRevision })) } : { ticketId: review.id }) }
    try {
      await write('/api/control', { action: kind === 'plan' ? 'delete-plan' : 'delete-task', params, confirmation: review.id })
      onDeleted()
    } catch (reason) { setError(`${String(reason)}。无法确认删除结果，请刷新核对状态。重试同一请求不会重复删除。`) }
    finally { setBusy(false) }
  }
  return <details className="deletion-controls"><summary>{label}</summary>
    <p>从列表与调度中删除，保留审计快照、阶段结论、资料、Git 分支及工作区，不关闭远端 MR。不提供一键恢复，也不会释放文件空间。</p>
    {kind === 'task' && record.planId ? <p className="notice">此任务属于关联计划，不能单独删除。请在所属计划详情中删除整组，避免破坏依赖关系。</p> : <>
      {blocked && <p className="notice">存在执行中、排队中或待核对的任务，请先停止并等待清理完成。</p>}
      <button disabled={busy || blocked || !members.length} onClick={preview}>预览删除范围</button>
      {review && <div className="review"><h4>{label}：{review.title}</h4><p>目标 ID：<code>{review.id}</code> · 版本 r{review.expectedRevision} · 共 {review.tasks.length} 个任务</p>
        <ul>{review.tasks.map(task => <li key={task.ticketId}>{task.title} · r{task.expectedRevision} · <code>{task.ticketId}</code></li>)}</ul>
        <label>输入“删除”确认<input aria-label="删除确认" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
        <nav><button disabled={busy || blocked || confirmation !== '删除'} onClick={() => { void submit() }}>{busy ? '删除中…' : `确认${label}`}</button><button disabled={busy} onClick={() => { setReview(undefined); setConfirmation('') }}>取消</button></nav>
      </div>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </details>
}
