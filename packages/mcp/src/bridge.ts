import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { tools } from '../../core/src/engine.js'
import { invoke } from '../../service/src/ipc.js'

const descriptions: Record<keyof typeof tools, string> = {
  task_create: 'Create a manual task in the registered repository. Does not start a Worker.',
  task_get: 'Read a task, pending approvals and bounded audit history.',
  task_list: 'List tasks with optional stage filtering and pagination.',
  task_message: 'Append context to an existing task. Does not release a human stop.',
  task_start: 'Request execution authorization. A human must approve in the trusted local CLI.',
  task_resume: 'Request explicit resumption of an idle or stopped task; requires human authorization.',
  task_retry: 'Request another attempt of failed or blocked work; never retries uncertain operations.',
  task_stop: 'Persist a human hold and request cancellation of the owned execution.',
  task_publish: 'Request publication preview and human approval. Never merges a PR.',
  health: 'Read service health, registered repository ID and runtime acceptance gates.',
}
export function createBridge(state: string): McpServer {
  const server = new McpServer({ name: 'superagent', version: '0.1.0' })
  for (const name of Object.keys(tools) as (keyof typeof tools)[]) {
    const readOnly = ['task_get', 'task_list', 'health'].includes(name)
    server.registerTool(`superagent_${name}`, { description: descriptions[name], inputSchema: tools[name], annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: name === 'task_publish' } }, async (params: unknown) => {
      try {
        const result = await invoke(state, 'bridge', name, params)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok }
      } catch {
        const result = { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'Local task service is unavailable. Ask the user to start it explicitly; do not auto-launch or retry a write with a new requestId.' } }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true }
      }
    })
  }
  return server
}
export async function bridge(state: string): Promise<void> { await createBridge(state).connect(new StdioServerTransport()) }
