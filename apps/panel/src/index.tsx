import React, { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './panel.css'

interface Envelope { ok: boolean; data?: any; error?: { message: string } }
async function read(path: string): Promise<any> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(response.status === 401 ? '请先登录' : '本地服务暂不可用')
  const result: Envelope = await response.json()
  if (!result.ok) throw new Error(result.error?.message ?? '请求失败')
  return result.data
}
function Panel() {
  const [token, setToken] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [error, setError] = useState('')
  const [health, setHealth] = useState<any>()
  const [tasks, setTasks] = useState<any[]>([])
  const [cursor, setCursor] = useState(0)
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<any>()
  const [eventCursor, setEventCursor] = useState(0)
  async function login(event: FormEvent) {
    event.preventDefault()
    const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    setToken('')
    if (response.ok) { setLoggedIn(true); setError('') } else setError('登录失败，请使用当前终端显示的令牌')
  }
  useEffect(() => {
    if (!loggedIn) return
    let disposed = false
    const refresh = async () => {
      try {
        const [status, page, task] = await Promise.all([read('/api/health'), read(`/api/tasks?cursor=${cursor}`), selected ? read(`/api/tasks/${selected}?cursor=${eventCursor}`) : undefined])
        if (!disposed) { setHealth(status); setTasks(page.items); setNextCursor(page.nextCursor); setDetail(task); setError('') }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : '读取失败') }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [loggedIn, cursor, selected, eventCursor])
  return <main>
    <header><div><small>LOCAL TASK CONTROL</small><h1>Superagent</h1></div><span className="badge">只读监督看板</span></header>
    <p className="notice">执行、发布和权限审批请使用可信终端。这里不会自动启动 Worker、推送代码或批准操作。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!loggedIn ? <form onSubmit={login}><h2>本地登录</h2><label htmlFor="token">从启动看板的终端复制登录令牌</label><input id="token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /><button>登录</button></form> : <>
      <section className="metrics"><article><small>调度</small><strong>{health?.paused ? '已暂停派发' : '接收任务'}</strong></article><article><small>Worker</small><strong>{health?.activeWorkers ?? '未知'}</strong></article><article><small>待处理副作用</small><strong>{health?.pendingEffects ?? '未知'}</strong></article><article><small>真实执行验收</small><strong>{health?.executionEnabled ? '通过' : '未通过 · 已禁用'}</strong></article></section>
      <section className="columns"><div><h2>任务列表</h2><ul>{tasks.map(task => <li key={task.id}><button className={selected === task.id ? 'selected' : ''} onClick={() => { setSelected(task.id); setEventCursor(0) }}><strong>{task.title}</strong><span>{task.stage} · r{task.revision}</span><small>{task.id}</small></button></li>)}</ul>{tasks.length === 0 && <p>没有任务。通过 Codex 工具或本地 CLI 明确建单。</p>}<nav><button disabled={cursor === 0} onClick={() => setCursor(Math.max(0, cursor - 50))}>上一页</button><button disabled={nextCursor === null} onClick={() => setCursor(nextCursor!)}>下一页</button></nav></div>
      <div><h2>任务详情与审计</h2>{detail ? <><p><strong>{detail.ticket.title}</strong> · {detail.stage}</p><h3>任务范围</h3><pre>{detail.ticket.scope}</pre><h3>状态与人工待办</h3><pre>{JSON.stringify({ humanHold: detail.ticket.mandate.humanHold, report: detail.ticket.report, reconciliation: detail.ticket.reconciliation, failure: detail.ticket.failure, pull: detail.ticket.pull, approvals: detail.approvals }, null, 2)}</pre><h3>输入与执行记录</h3><pre>{JSON.stringify({ inputs: detail.ticket.inputs, assignments: detail.ticket.assignments, binding: detail.ticket.binding }, null, 2)}</pre><h3>审计事件</h3><pre>{JSON.stringify(detail.events, null, 2)}</pre><nav><button disabled={eventCursor === 0} onClick={() => setEventCursor(0)}>首批事件</button><button disabled={detail.events.length < 50} onClick={() => setEventCursor(detail.events.at(-1).sequence)}>后续事件</button></nav></> : <p>选择任务查看状态、PR、输入、审批与事件。</p>}</div></section>
      <details><summary>服务健康与兼容性</summary><pre>{JSON.stringify(health, null, 2)}</pre></details>
    </>}
    <footer>单用户 · 单仓库 · 本地持久化。真实模型执行会将必要任务与代码上下文发送给模型供应商。</footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<Panel />)
