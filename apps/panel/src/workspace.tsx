import React, { useEffect, useState } from 'react'
import { write } from './controls.js'

export function PlanWorkspace({ detail, onChange }: { detail: any; onChange(): void }) {
  const plan = detail.plan
  const [baseRef, setBaseRef] = useState(plan.workspace?.baseRef ?? '')
  const [branchPrefix, setBranchPrefix] = useState(plan.workspace?.branchPrefix ?? 'superagent')
  const [preview, setPreview] = useState<any>()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    setBaseRef(plan.workspace?.baseRef ?? ''); setBranchPrefix(plan.workspace?.branchPrefix ?? 'superagent')
    setPreview(undefined); setConfirmation('')
  }, [plan.id, plan.revision])
  async function submit(configure: boolean) {
    setBusy(true); setMessage('')
    try {
      const params = configure ? { planId: plan.id, expectedRevision: preview.revision, previewId: preview.id, requestId: preview.requestId, confirmation } : { planId: plan.id, expectedRevision: plan.revision, repositoryId: detail.tasks[0].ticket.repositoryId, baseRef, branchPrefix }
      const result = await write(`/api/plans/${plan.id}/workspace/${configure ? 'configure' : 'preview'}`, params)
      if (configure) { setPreview(undefined); setConfirmation(''); setMessage('工作区绑定已更新，旧文件与分支已保留。请重新确认目标后继续调度。'); onChange() }
      else setPreview({ ...result.data, requestId: crypto.randomUUID() })
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  return <details><summary>计划工作区与基线 · {plan.workspace?.targetBranch ?? '旧项目默认基线'}</summary>
    {plan.workspace ? <><p>仓库 ID：<code>{plan.workspace.repositoryId}</code></p><p>本地引用：<code>{plan.workspace.baseRef}</code> → 固定 SHA：<code>{plan.workspace.baseSha}</code></p><p>发布目标：{plan.workspace.targetBranch} · 工作分支前缀：{plan.workspace.branchPrefix}</p><p>解析于 {new Date(plan.workspace.resolvedAt).toLocaleString()}；未 fetch，分支前进不会自动更新基线。</p></> : <p className="notice">旧计划仍使用项目默认基线，不会根据任务文字切换 main / insight-v1。需要其他基线时，请在此显式配置。</p>}
    <p>迁移保留原工作区、分支、未提交修改与历史，生成新绑定并使旧授权失效。运行中、待核对、已有验收结果或 MR 的计划不能直接迁移。</p>
    <label>完整本地分支引用<input disabled={busy} placeholder="refs/remotes/origin/main 或 refs/heads/main" value={baseRef} onChange={event => { setBaseRef(event.target.value); setPreview(undefined) }} /></label>
    <label>工作分支前缀<input disabled={busy} value={branchPrefix} onChange={event => { setBranchPrefix(event.target.value); setPreview(undefined) }} /></label>
    <button disabled={busy || plan.completed || !baseRef.trim() || !branchPrefix.trim()} onClick={() => { void submit(false) }}>预览基线与影响</button>
    {preview && <div className="review"><h4>确认新的固定基线</h4><p>{preview.selection.baseRef} → <code>{preview.selection.baseSha}</code> · 发布目标 {preview.targetBranch}</p><p>{preview.notice}</p><ul>{preview.members.map((member: any) => <li key={member.id}><code>{member.id}</code> · 保留旧目录 {member.workspace ?? '尚未创建'} · 旧基线 {member.baseSha ?? '尚未分配'}</li>)}</ul><p>预览有效期至 {new Date(preview.expiresAt).toLocaleString()}</p><label>输入完整计划 ID 确认：<code>{plan.id}</code><input disabled={busy} autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button disabled={busy || confirmation !== plan.id || Date.now() >= preview.expiresAt} onClick={() => { void submit(true) }}>确认切换绑定（不立即执行）</button></div>}
    {message && <p role="status" className="notice">{message}</p>}
  </details>
}

export function TaskWorkspace({ detail, onChange }: { detail: any; onChange(): void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const ticket = detail.ticket
  async function prepare() {
    setBusy(true); setMessage('')
    try {
      const result = await write(`/api/tasks/${ticket.id}/workspace/prepare`, { ticketId: ticket.id, expectedRevision: ticket.revision })
      setMessage(result.data.ready ? '工作区检查通过，将按已授权计划继续调度。' : result.data.reason)
      onChange()
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  return <details open={detail.scheduling.state === 'waiting_workspace'}><summary>执行工作区 · 服务托管</summary><p>目录：<code>{ticket.workspace ?? '派发前准备'}</code></p><p>分支：<code>{ticket.branch ?? '派发前分配'}</code></p><p>基线：<code>{ticket.workspaceBinding?.baseRef ?? '项目默认基线'}</code> · 固定 SHA：<code>{ticket.workspaceBinding?.baseSha ?? ticket.baseSha ?? '尚未分配'}</code></p><p>服务创建与核验 worktree；Worker 在此目录编辑，不必自行创建 worktree 或切换分支。准备失败不启动模型、不消耗执行轮次。</p><button disabled={busy || !['ready', 'waiting_workspace'].includes(detail.scheduling.state)} onClick={() => { void prepare() }}>{busy ? '检查中…' : '重新检查工作区'}</button>{message && <p role="status">{message}</p>}</details>
}
