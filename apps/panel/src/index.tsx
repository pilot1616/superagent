import React, { useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './panel.css'
import { ApprovalPanel, EntityControls, WorkerDiagnostics, read } from './controls.js'
import { DependencyGraph, statusLabel, taskStatus } from './graph.js'
import { TaskDetail } from './task-detail.js'
import { RuntimePanel, RuntimeQuestion } from './runtime.js'
import { DeletionControl } from './deletion.js'
import { PlanWorkspace } from './workspace.js'

function useRead(path: string | undefined, version: number) {
  const [value, setValue] = useState<any>()
  const [error, setError] = useState('')
  useEffect(() => {
    setValue(undefined); setError('')
    if (!path) return
    let disposed = false
    const refresh = async () => { try { const data = await read(path); if (!disposed) { setValue(data); setError('') } } catch (reason) { if (!disposed) setError(String(reason)) } }
    void refresh(); const interval = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [path, version])
  return { value, error }
}

function TaskList({ version, selected, onSelect }: { version: number; selected: string; onSelect(id: string): void }) {
  const [view, setView] = useState('active')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const { value: page, error } = useRead(`/api/tasks?view=${view}&query=${encodeURIComponent(query)}&cursor=${cursor}&limit=10`, version)
  useEffect(() => { if (page && cursor > 0 && cursor >= page.total) setCursor(Math.max(0, Math.ceil(page.total / 10) * 10 - 10)) }, [page, cursor])
  const filters = [['active', '未完成'], ['attention', '待我处理'], ['finished', '已结束'], ['all', '全部']]
  return <section className="surface"><div className="section-heading"><h2>精简任务列表</h2><input aria-label="搜索任务名称" placeholder="搜索任务名称" value={query} onChange={event => { setQuery(event.target.value); setCursor(0) }} /></div>
    <nav>{filters.map(([key, label]) => <button className={view === key ? 'selected' : ''} key={key} onClick={() => { setView(key); setCursor(0) }}>{label} {page?.counts[key] ?? '—'}</button>)}</nav>
    {error && <p role="alert" className="error">{error}</p>}<ul className="compact-list">{page?.items.map((task: any) => <li key={task.id}><button className={selected === task.id ? 'selected' : ''} onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span className="status">{taskStatus(task)}</span><small className="summary-line">{task.summary || '尚无阶段结论'}</small></button></li>)}</ul>
    {page && !page.items.length && <p>该筛选下没有任务。任务通过 Codex 或 CLI 创建。</p>}<nav className="pager"><button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 10))}>上一页</button><small>共 {page?.total ?? '—'} 项 · 每页最多 10 项</small><button disabled={!page || page.nextCursor === null} onClick={() => setCursor(page.nextCursor)}>下一页</button></nav>
  </section>
}

function PlanList({ version, selectedTask, onSelectTask, onChange }: { version: number; selectedTask: string; onSelectTask(id: string): void; onChange(): void }) {
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState('')
  const { value: page, error } = useRead(`/api/plans?cursor=${cursor}&limit=10`, version)
  const active = selected || page?.items[0]?.id || ''
  const { value: detail, error: detailError } = useRead(active ? `/api/plans/${active}` : undefined, version)
  return <section><h2>计划总览与任务依赖</h2>{(error || detailError) && <p role="alert" className="error">{error || detailError}</p>}
    <div className="columns plan-columns"><div><ul className="compact-list">{page?.items.map((plan: any) => <li key={plan.id}><button className={active === plan.id ? 'selected' : ''} onClick={() => { setSelected(plan.id); onSelectTask('') }}><strong>{plan.title}</strong><small>{plan.completed ? '整体验收完成' : plan.held ? '整组停止' : plan.paused ? '暂停派发' : '任务计划'} · {plan.ticketIds.length} 个节点</small></button></li>)}</ul>{page && !page.items.length && <p>尚无关联任务计划。先让 Codex 根据需求建立任务依赖计划；独立任务可在“任务”页查看。</p>}<nav className="pager"><button disabled={!cursor} onClick={() => { setCursor(Math.max(0, cursor - 10)); setSelected(''); onSelectTask('') }}>上一页</button><button disabled={!page || page.nextCursor === null} onClick={() => { setCursor(page.nextCursor); setSelected(''); onSelectTask('') }}>下一页</button></nav></div>
      <div>{detail?.plan?.id === active ? <><div className="section-heading"><h3>{detail.plan.title}</h3><span className="badge">{statusLabel(detail.outcome)}</span></div><p>已交接 / 验收 {detail.acceptedResults} / {detail.requiredResults} · 图版本 {detail.plan.version} · 部分验收不等于完成</p><div className="status-counts">{Object.entries(detail.counts).map(([state, count]) => <span className="badge" key={state}>{statusLabel(state)} {String(count)}</span>)}</div><DependencyGraph detail={detail} selected={selectedTask} onSelect={onSelectTask} />
        <details open={!detail.plan.grant && !detail.plan.completed}><summary>目标确认与调度控制</summary><p>最多 {detail.plan.maxAttempts} 次执行分配 / 节点 · 到期 {new Date(detail.plan.expiresAt).toLocaleString()}</p><EntityControls kind="plan" record={detail.plan} detail={detail} onChange={onChange} /><pre>{JSON.stringify({ grant: detail.plan.grant, approvals: detail.approvals }, null, 2)}</pre></details>
        <PlanWorkspace detail={detail} onChange={onChange} /><DeletionControl kind="plan" record={detail.plan} tasks={detail.tasks} onDeleted={() => { setSelected(''); setCursor(0); onSelectTask(''); onChange() }} /></> : <p>选择计划查看依赖图；点击图中的任务查看阶段结论。</p>}</div></div>
  </section>
}

function ContextList({ version }: { version: number }) {
  const [cursor, setCursor] = useState(0)
  const [eventCursor, setEventCursor] = useState(0)
  const [selected, setSelected] = useState('')
  const { value: page, error } = useRead(`/api/threads?cursor=${cursor}&limit=10`, version)
  const { value: detail, error: detailError } = useRead(selected ? `/api/threads/${selected}?cursor=${eventCursor}` : undefined, version)
  return <section className="surface"><h2>共享上下文与路由</h2><p>上下文关联不隐式授予任务权限。</p>{(error || detailError) && <p className="error" role="alert">{error || detailError}</p>}<ul>{page?.items.map((item: any) => <li key={item.id}><button onClick={() => { setSelected(item.id); setEventCursor(0) }}>{item.title}</button></li>)}</ul><nav><button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 10))}>上一页</button><button disabled={!page || page.nextCursor === null} onClick={() => setCursor(page.nextCursor)}>下一页</button></nav>{detail?.thread.id === selected && <details open><summary>{detail.thread.title}</summary><pre>{JSON.stringify(detail, null, 2)}</pre><nav><button disabled={!eventCursor} onClick={() => setEventCursor(0)}>首批事件</button><button disabled={detail.nextCursor === null} onClick={() => setEventCursor(detail.nextCursor)}>后续事件</button></nav></details>}</section>
}

function Panel() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [token, setToken] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  useEffect(() => { const expired = () => { setLoggedIn(false); setLoginError('登录已过期，请重新登录。') }; window.addEventListener('superagent-session-expired', expired); return () => window.removeEventListener('superagent-session-expired', expired) }, [])
  const [version, setVersion] = useState(0)
  const [tab, setTab] = useState('plans')
  const [selected, setSelected] = useState('')
  const { value: health, error } = useRead(loggedIn ? '/api/health' : undefined, version)
  const { value: approvals } = useRead(loggedIn ? '/api/approvals' : undefined, version)
  const changed = () => setVersion(current => current + 1)
  async function login(event: FormEvent) {
    event.preventDefault()
    if (loggingIn) return
    setLoggingIn(true)
    try {
      const response = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
      setToken('')
      if (!response.ok) throw new Error(response.status === 401 ? '令牌不匹配，请在可信终端查看当前项目令牌。' : response.status === 403 ? '请求来源校验失败，请刷新本项目控制台。' : response.status === 429 ? '尝试过多，请一分钟后重试。' : '服务不可用，请检查连接。')
      setLoggedIn(true); setLoginError('')
    } catch (reason) { setLoginError(String(reason)) } finally { setLoggingIn(false) }
  }
  return <main><header><div><small>LOCAL TASK CONTROL</small><h1>Superagent</h1></div><span className="badge">人工任务控制台</span></header>
    {(loginError || error) && <p role="alert" className="error">{loginError || error}</p>}
    {!loggedIn ? <form onSubmit={login}><h2>本地登录</h2><label htmlFor="token">在可信终端读取该项目的登录令牌，不要发给模型。</label><input id="token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /><button disabled={loggingIn}>{loggingIn ? '登录中' : '登录'}</button></form> : <>
      <p>当前项目：<code>{health?.repository?.path ?? '读取中'}</code></p><div className="metrics"><article><small>调度</small><strong>{health?.paused ? '暂停派发' : '接收任务'}</strong></article><article><small>运行 Worker</small><strong>{health?.activeWorkers ?? '—'}</strong></article><article><small>执行环境</small><strong>{health?.executionEnabled ? '已就绪' : '等待准备'}</strong></article></div>
      <details><summary>{health?.runtime?.canDispatch ? '运行环境就绪 · 展开诊断' : health?.runtime?.phase === 'ready' ? '确认目标时自动准备运行环境' : `环境待处理：${health?.runtime?.reasonCodes?.[0] ?? '检查中'}`}</summary><RuntimePanel runtime={health?.runtime} repositoryId={health?.repository?.id} onChange={changed} /></details>
      {approvals?.filter((approval: any) => approval.details.method === 'item/tool/requestUserInput').map((approval: any) => <RuntimeQuestion key={approval.id} approval={approval} repositoryId={health?.repository?.id} onChange={changed} />)}
      <nav className="tabs">{[['plans', '计划与依赖'], ['tasks', '任务'], ['approvals', '需要你确认'], ['context', '共享上下文']].map(([key, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => { setTab(key); setSelected('') }}>{label}</button>)}<button onClick={changed}>刷新</button></nav>
      {tab === 'plans' && <PlanList version={version} selectedTask={selected} onSelectTask={setSelected} onChange={changed} />}{tab === 'tasks' && <TaskList version={version} selected={selected} onSelect={setSelected} />}{tab === 'approvals' && <ApprovalPanel onChange={changed} />}{tab === 'context' && <ContextList version={version} />}
      {selected && ['plans', 'tasks'].includes(tab) && <TaskDetail key={selected} ticketId={selected} refreshVersion={version} onChange={changed} onClose={() => setSelected('')} />}
      <details><summary>服务健康与兼容性</summary><pre>{JSON.stringify(health, null, 2)}</pre></details>
    </>}<footer>一次目标确认 · 依赖自动调度 · 发布单独确认 · 不自动合并 MR。真实执行会将必要任务与代码上下文发送给模型供应商。</footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<Panel />)
