import React, { useId } from 'react'
import { graphLayout } from '../../../packages/core/src/graph-layout.js'

const labels: Record<string, string> = {
  waiting_workspace: '等待工作区准备',
  draft: '待启动', queued: '已排队', working: '执行中', approval: '待审批', answer: '待回答', waiting: '等待下一步', review: '待代码评审', blocked: '有阻塞', failed: '执行失败', stopping: '正在停止', stopped: '已停止', completed: '已完成', ended: '已结束', dropped: '未交付即结束', reconciling: '需核对状态', ready: '可调度', held: '人工停止', paused: '暂停派发', waiting_runtime: '等待运行环境', waiting_dependencies: '等待前置结果', waiting_resources: '等待资源', waiting_authorization: '等待授权', running: '执行中', idle: '本轮结束', accepted: '结果已验收', partially_accepted: '部分已交接 / 验收', pending: '等待推进', incomplete: '存在未交付节点',
}
export const statusLabel = (value: string) => labels[value] ?? value
export const taskStatus = (entry: any) => entry.ticket?.result ? `${entry.ticket.result.acceptedBy === 'coordinator' ? '系统已交接' : '人工已验收'}${entry.ticket.mandate.humanHold ? ' · 人工停止' : ''}` : entry.acceptedBy ? entry.acceptedBy === 'coordinator' ? '系统已交接' : '人工已验收' : (entry.ticket?.report?.state === 'ready' || entry.awaitingAcceptance) && !['held', 'running', 'reconciling'].includes(entry.scheduling?.state) ? '待结果验收' : statusLabel(entry.scheduling?.state === 'idle' ? entry.stage : entry.scheduling?.state ?? entry.stage)

export function DependencyGraph({ detail, selected, onSelect }: { detail: any; selected?: string; onSelect(id: string): void }) {
  const marker = `arrow-${useId().replaceAll(':', '')}`
  const { nodes, width, height } = graphLayout(detail.plan.ticketIds, detail.plan.dependencies)
  const entries = new Map<string, any>(detail.tasks.map((entry: any) => [entry.ticket.id, entry]))
  const positions = new Map(nodes.map(node => [node.id, node]))
  return <div className="graph-container"><p className="muted">前置 → 后续；普通产物按已授权规则交接，人工里程碑与代码依赖保留验收。点击节点查看结论或调整任务。</p>
    <div className="graph-scroll"><svg width={width} height={height} role="group" aria-label={`${detail.plan.title}任务依赖图`}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8391a8" /></marker></defs>
      {detail.plan.dependencies.map((edge: any) => {
        const before = positions.get(edge.before)!, after = positions.get(edge.after)!
        const start = before.x + 218, end = after.x, center = (start + end) / 2
        return <g key={`${edge.before}:${edge.after}`}><path d={`M ${start} ${before.y + 38} C ${center} ${before.y + 38}, ${center} ${after.y + 38}, ${end - 3} ${after.y + 38}`} fill="none" stroke="#8391a8" strokeWidth="1.5" strokeDasharray={edge.condition === 'code' ? undefined : '5 3'} markerEnd={`url(#${marker})`}><title>{edge.condition === 'code' ? '代码合并并验收' : '产物交接 / 验收'}</title></path></g>
      })}
      {nodes.map(node => {
        const entry = entries.get(node.id)
        const title = entry.ticket.title as string
        return <g key={node.id} role="button" tabIndex={0} aria-label={`${title}，${taskStatus(entry)}`} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) } }} className="graph-node">
          <title>{title} · {taskStatus(entry)}</title><rect x={node.x} y={node.y} width="218" height="82" rx="9" fill={entry.ticket.result ? '#ecf8f0' : selected === node.id ? '#edf3ff' : 'white'} stroke={selected === node.id ? '#245ac4' : '#ccd4e0'} strokeWidth={selected === node.id ? 2 : 1} />
          <text x={node.x + 12} y={node.y + 24} className="graph-title">{title.length > 16 ? `${title.slice(0, 16)}…` : title}</text><text x={node.x + 12} y={node.y + 49} className="graph-status">{taskStatus(entry)}</text><text x={node.x + 12} y={node.y + 69} className="graph-meta">{node.id === detail.plan.integrationId ? '整体集成验收' : entry.ticket.reviewRequired ? '人工里程碑' : `优先级 ${entry.ticket.priority ?? 0}`}</text>
        </g>
      })}
    </svg></div>
    <details><summary>文字依赖关系 · {detail.plan.dependencies.length} 条</summary><ul>{detail.plan.dependencies.map((edge: any) => <li key={`${edge.before}:${edge.after}`}>{entries.get(edge.before)?.ticket.title} → {entries.get(edge.after)?.ticket.title}（{edge.condition === 'code' ? '代码合并并验收' : '产物交接 / 验收'}）</li>)}</ul></details>
  </div>
}
