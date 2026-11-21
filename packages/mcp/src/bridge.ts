import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { tools } from '../../core/src/engine.js'
import { readOperations } from '../../core/src/coordination.js'
import { invoke } from '../../service/src/ipc.js'
import { fileURLToPath } from 'node:url'
import { DomainError } from '../../core/src/model.js'
import { ProjectSession, projectOpen } from '../../service/src/projects.js'

const descriptions: Record<keyof typeof tools, string> = {
  plan_workspace_preview: 'Preview a plan baseline using a full local Git ref and branch prefix in the current registered repository. Never fetches or authorizes migration. Human confirmation is required to apply the preview.',
  task_workspace_prepare: 'Prepare or recheck the managed worktree for an authorized schedulable task before a Worker starts. Cannot choose arbitrary paths, run arbitrary Git commands or expand permissions. Failures block dispatch without consuming an execution attempt.',
  thread_create: 'Create a durable context thread for multiple tasks; grants no permission.',
  thread_get: 'Read subscriptions, correlations and paginated events.',
  thread_list: 'List context threads with pagination.',
  thread_subscribe: 'Subscribe a task as owning/context-only or remove a non-origin subscription. Does not resume tasks.',
  thread_unrelated: 'Atomically unsubscribe a non-origin thread and return its owned follow-ups for routing, preserving delivery history.',
  event_record: 'Record context once and fan out to subscribed live tasks. External/context input never grants permission.',
  route_context: 'Read a candidate event, related tasks and ownership before routing work.',
  task_route: 'Route explicit events: accept as draft, attach to an explicit task, ignore, or stop. Each item is independently validated and audited.',
  task_handback: 'Return an owned input for fresh routing; retains history and never undelivers model input.',
  plan_create: 'Create a bounded goal DAG. Declare only user-supplied absolute file paths in workflow.materialPaths; one human goal confirmation prepares restricted execution and distributes read-only snapshots. Normal artifact handoffs are automatic by default; mark reviewRequired milestones. Does not execute or authorize itself.',
  plan_get: 'Read a plan, dependency graph, blockers and pending human approvals.',
  plan_list: 'List multi-task plans with pagination.',
  plan_update: 'Revise dependencies and constraints before execution; invalidates prior authorization.',
  plan_start: 'Request one human goal confirmation covering the DAG, budget, declared materials and restricted environment preparation. Cannot self-approve. For new workflows, do not ask the user to separately enable Workers or attach materials per task.',
  plan_pause: 'Pause/unpause new dispatch without terminating running tasks or clearing holds.',
  plan_stop: 'Hold the plan and stop unfinished tasks, preserving independent holds.',
  task_create: 'Create a manual task in the registered repository. Does not start a Worker.',
  task_get: 'Read a task, pending approvals and bounded audit history.',
  task_list: 'List tasks with optional stage filtering and pagination.',
  task_message: 'Append context to an existing task. Does not release a human stop.',
  task_adjust: 'Stop and revise a task scope with a reason and current revisions. Plan members stop the group and invalidate its authorization. Preserves history, accepted results and independent holds; requires fresh human approval before execution.',
  task_start: 'Request execution authorization. A human must approve in the local dashboard or trusted CLI.',
  task_resume: 'Request explicit resumption of an idle or stopped task; requires human authorization.',
  task_retry: 'Explicitly retry failed/blocked work within the approved plan budget. Exhausted budgets request human approval for exactly one additional assignment; never self-authorize or retry uncertain operations.',
  task_stop: 'Persist a human hold and request cancellation of the owned execution.',
  task_publish: 'Request GitLab merge request publication preview and human approval. Never merges an MR.',
  health: 'Read service health, registered repository ID and runtime acceptance gates.',
}
const reply = (result: { ok: boolean; [key: string]: unknown }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok })
const failure = (error: unknown) => reply({ ok: false, error: { code: error instanceof DomainError ? error.code : 'RUNTIME_UNAVAILABLE', message: error instanceof DomainError ? error.message : 'Local project service is unavailable. Inspect the project state before retrying; never blindly replay a write.' } })

export function createBridge(state: string | (() => Promise<string>)): McpServer {
  const server = new McpServer({ name: 'superagent', version: '0.1.0' })
  for (const name of Object.keys(tools) as (keyof typeof tools)[]) {
    const readOnly = readOperations.includes(name)
    server.registerTool(`superagent_${name}`, { description: descriptions[name], inputSchema: tools[name], annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: name !== 'plan_workspace_preview', openWorldHint: name === 'task_publish' } }, async (params: unknown) => {
      try {
        const result = await invoke(typeof state === 'string' ? state : await state(), 'bridge', name, params)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok }
      } catch (error) { return failure(error) }
    })
  }
  return server
}
export function createProjectBridge(root: string): McpServer {
  let server: McpServer
  const session = new ProjectSession(root, async () => {
    if (!server.server.getClientCapabilities()?.roots) return undefined
    const result = await server.server.listRoots({}, { timeout: 5000 })
    return result.roots.filter(entry => entry.uri.startsWith('file:')).map(entry => fileURLToPath(entry.uri))
  })
  server = createBridge(() => session.state())
  server.registerTool('superagent_project_open', {
    description: 'Bind this conversation connection to its actual current Git project. Validate host workspace roots when available; never fall back to another repository. Explicitly open/start the local coordination service. First setup requires initialize=true and a chosen or locally configured default model. Does not authorize Workers. Returns project-specific dashboard URL, never a login token.',
    inputSchema: projectOpen,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async params => {
    try { return reply({ ok: true, data: await session.select(params) }) }
    catch (error) { return failure(error) }
  })
  return server
}
export async function bridge(state: string): Promise<void> { await createBridge(state).connect(new StdioServerTransport()) }
export async function projectBridge(root: string): Promise<void> { await createProjectBridge(root).connect(new StdioServerTransport()) }
