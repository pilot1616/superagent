#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolve, join } from 'node:path'
import { defaultState, initialize, readConfig, recoverLock, migrateConfig, configureWorkerProfile } from './config.js'
import { invoke } from './ipc.js'
import { startService } from './daemon.js'
import { checkWorker, codexVersion, SUPPORTED_CODEX } from '../../executor-codex/src/probe.js'
import { bridge, projectBridge } from '../../mcp/src/bridge.js'
import { defaultProjectsRoot, writePrivateJson, configureProjects } from './projects.js'
import { startPanel } from './panel.js'
import { requireCondition } from '../../core/src/model.js'
import { recoverPanel } from './panel-token.js'
import { deletionSchemas } from '../../core/src/deletion.js'

const HELP = `superagent-local — local single-repository multi-task coordination service

init --repo PATH --worktrees PATH --model NAME [--base HEAD] [--state PATH] [--gitlab-url HTTPS_ORIGIN]
projects configure --json '{...}'          Configure local model defaults/imported project mappings
serve [--state PATH] [--with-panel]          Foreground daemon; optional private approval panel
status | doctor | approvals                Read service or compatibility information
worker-check [--state PATH]                Diagnose isolated Worker profile; no model turn or authorization
runtime status|check|verify-preview|enable-preview|disable-preview  Inspect/review the current project runtime
runtime verify|enable|disable --json '{...}'  Interactive, versioned human control; no public MCP equivalent
runtime verification RUN_ID                Read an evidence-backed verification run
runtime cancel-verification RUN_ID --json '{...}'  Cancel a bounded verification
runtime migrate                            Offline v2 -> v3 configuration migration with SQLite backup
runtime configure-profile --json '{model,provider}'  Offline explicit Worker model/provider selection; no credentials
runtime configure-capabilities --json '{skills,toolchain}'  Offline reviewed skill snapshots and toolchain; no credentials
materials preview|attach|list --json '{...}'  Human-reviewed task-local read-only reference files
workspace preview|configure|prepare --json '{...}'  Plan baseline preview, human migration, or worktree recheck
task delete | plan delete --json '{...}'    Interactive deletion; keeps audit, worktrees and files
answer REQUEST_ID --json '{...}'             Answer current Worker questions, never expand permissions
panel [--port NUMBER] [--token-file PATH]   Local approval/control dashboard; private login token
task OPERATION --json '{...}'               Public task operation; requestId required for writes
plan OPERATION --json '{...}'               Create/get/list/update/start/pause/stop a task graph
thread OPERATION --json '{...}'             Create/get/list/subscribe shared context
event record --json '{...}'                 Record and fan out context once
route context --json '{...}'                Inspect related tasks before routing
accept-result --json '{ticketId,expectedRevision,kind,content}'
complete-plan --json '{planId,expectedRevision}'
approve ID | decline ID                    Interactive human approval; no approve-all
pause | unpause | backup | shutdown         Trusted administrative operations
inspect TICKET                            Inspect a managed workspace without publication
publish-preview ID --author-name NAME --author-email EMAIL
observe TICKET | reconcile-publish TICKET  Read only the task's bound MR / reconcile delivery
complete TICKET                           Accept local work without a MR
reconcile TICKET --note TEXT --disposition pending|settled
recover-lock                              Remove a lock only after its owner is dead
recover-panel                             Recover a dead panel instance; refuses live/reused PIDs
mcp bridge [--projects-root PATH]          Session project MCP; explicit project_open setup/start
mcp bridge --state PATH                    Legacy fixed-instance MCP

Worker execution requires real evidence, project enablement and task authorization. No automatic remote,
plugin installation, login, push or merge. Models may receive task/code context.
`
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
async function confirm(description: string, expected: string): Promise<void> {
  requireCondition(process.stdin.isTTY && process.stdout.isTTY, 'FORBIDDEN', 'Human authorization requires an interactive terminal')
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(`${description}\n`)
    const answer = await terminal.question(`Type ${JSON.stringify(expected)} to confirm: `)
    requireCondition(answer === expected, 'FORBIDDEN', 'Confirmation did not match')
  } finally { terminal.close() }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { state: { type: 'string' }, repo: { type: 'string' }, worktrees: { type: 'string' }, model: { type: 'string' }, base: { type: 'string' }, 'gitlab-url': { type: 'string' }, json: { type: 'string' }, note: { type: 'string' }, disposition: { type: 'string' }, 'author-name': { type: 'string' }, 'author-email': { type: 'string' }, port: { type: 'string' }, 'token-file': { type: 'string' }, 'projects-root': { type: 'string' }, 'with-panel': { type: 'boolean' } } })
  const [command, identifier] = positionals
  const state = resolve(values.state ?? defaultState())
  if (!command || command === 'help') { process.stdout.write(HELP); return }
  if (command === 'projects' && identifier === 'configure') {
    const root = resolve(values['projects-root'] ?? defaultProjectsRoot())
    await configureProjects(root, JSON.parse(values.json ?? '{}'))
    print({ configured: true, projectsRoot: root, defaultRepository: null }); return
  }
  if (command === 'mcp' && identifier === 'bridge') {
    requireCondition(!values.state || !values['projects-root'], 'INVALID_REQUEST', 'Choose session project mode or explicit fixed --state, not both')
    if (values.state) await bridge(state)
    else await projectBridge(resolve(values['projects-root'] ?? defaultProjectsRoot()))
    return
  }
  if (command === 'panel') {
    requireCondition(process.stdout.isTTY || values['token-file'], 'FORBIDDEN', 'Use a trusted terminal or explicit private --token-file; login tokens must not enter model context')
    const port = Number(values.port ?? 0)
    requireCondition(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_REQUEST', 'Invalid port')
    await readConfig(state)
    const panel = await startPanel(state, port)
    if (values['token-file']) {
      try { requireCondition(resolve(values['token-file']) === join(state, 'panel-login.token'), 'FORBIDDEN', 'Panel token file must be STATE/panel-login.token') }
      catch (error) { await panel.close(); throw error }
      process.stdout.write(`Local approval dashboard: ${panel.origin}\nLogin token saved privately to ${values['token-file']}; read it only in your trusted terminal, never send it to a model.\n`)
    } else process.stdout.write(`Local approval dashboard: ${panel.origin}\nEnter this token in the login form, not in the URL: ${panel.loginSecret}\n`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void panel.close() })
    return
  }
  if (command === 'init') {
    requireCondition(values.repo && values.worktrees && values.model, 'INVALID_REQUEST', 'init requires --repo, --worktrees and an explicit --model')
    await initialize(state, values.repo, values.worktrees, values.model, values.base, values['gitlab-url'])
    print({ initialized: true, state, executionEnabled: false }); return
  }
  if (command === 'serve') {
    const service = await startService(state)
    if (values['with-panel']) {
      let panel: Awaited<ReturnType<typeof startPanel>> | undefined
      try {
        panel = await startPanel(state)
        service.server.once('close', () => { void panel?.close() })
        process.stderr.write(`Project approval dashboard: ${panel.origin}; login token is private at ${state}/panel-login.token\n`)
      } catch (error) { await service.close(); if (panel) await panel.close(); throw error }
    }
    process.stderr.write(`Superagent listening at ${state}/service.sock; Worker gate: ${service.runtime.status().canDispatch}\n`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().catch(() => { process.exitCode = 1 }) })
    return
  }
  if (command === 'doctor') {
    let version: string | undefined
    try { version = codexVersion('codex') } catch {}
    const config = await readConfig(state)
    const runtime = await invoke(state, 'admin', 'runtime-status').catch(() => undefined)
    print({ node: process.version, codex: version, supported: version === SUPPORTED_CODEX, config, runtime, executionEnabled: runtime?.ok ? (runtime.data as { canDispatch: boolean }).canDispatch : false }); return
  }
  if (command === 'worker-check') {
    await readConfig(state)
    try { print(await invoke(state, 'admin', 'worker-check')) }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; print(await checkWorker(state)) }
    return
  }
  if (command === 'recover-panel') { await confirm('Inspect the panel owner and recover only this stopped instance; never kill a reused PID.', 'recover-panel'); await recoverPanel(state); print({ recovered: true }); return }
  if (command === 'runtime') {
    if (identifier === 'configure-profile') { const params = JSON.parse(values.json ?? '{}'); await confirm(JSON.stringify(params, null, 2), 'configure-profile'); print(await configureWorkerProfile(state, params)); return }
    if (identifier === 'configure-capabilities') { const params = JSON.parse(values.json ?? '{}'); await confirm(JSON.stringify(params, null, 2), 'configure-capabilities'); print(await configureWorkerProfile(state, params, true)); return }
    if (identifier === 'migrate') { await confirm('Back up and migrate this stopped project state; no Worker will be enabled.', 'migrate'); await migrateConfig(state); print({ migrated: true, executionEnabled: false }); return }
    const methods: Record<string, string> = { status: 'runtime-status', check: 'runtime-check', 'verify-preview': 'runtime-verify-preview', verify: 'runtime-verify', verification: 'runtime-verification-get', 'cancel-verification': 'runtime-verification-cancel', 'enable-preview': 'runtime-enable-preview', enable: 'runtime-enable', 'disable-preview': 'runtime-disable-preview', disable: 'runtime-disable', reconcile: 'runtime-reconcile' }
    requireCondition(identifier && methods[identifier], 'INVALID_REQUEST', 'Unknown runtime operation')
    const params = JSON.parse(values.json ?? '{}')
    if (['verification', 'cancel-verification'].includes(identifier)) params.id = positionals[2]
    if (['verify', 'enable', 'disable', 'reconcile', 'cancel-verification'].includes(identifier)) { await confirm(JSON.stringify(params, null, 2), params.repositoryId); params.confirmation = params.repositoryId }
    const result = await invoke(state, 'admin', methods[identifier]!, params)
    print(result); if (!result.ok) process.exitCode = 1; return
  }
  if (command === 'materials') {
    requireCondition(identifier && ['preview', 'attach', 'list'].includes(identifier), 'INVALID_REQUEST', 'Specify materials preview, attach or list')
    const params = JSON.parse(values.json ?? '{}')
    if (identifier === 'attach') { await confirm(JSON.stringify(params, null, 2), params.ticketId); params.confirmation = params.ticketId }
    const result = await invoke(state, 'admin', `task-materials-${identifier}`, params)
    print(result); if (!result.ok) process.exitCode = 1; return
  }
  if (command === 'answer') {
    const params = JSON.parse(values.json ?? '{}')
    params.id = identifier
    await confirm(JSON.stringify(params, null, 2), identifier!)
    params.confirmation = identifier
    print(await invoke(state, 'admin', 'runtime-answer', params)); return
  }
  if (command === 'workspace') {
    const methods: Record<string, string> = { preview: 'plan_workspace_preview', configure: 'plan-workspace-configure', prepare: 'task_workspace_prepare' }
    requireCondition(identifier && methods[identifier], 'INVALID_REQUEST', 'Specify workspace preview, configure or prepare')
    const params = JSON.parse(values.json ?? '{}')
    if (identifier === 'configure') {
      const preview = await invoke(state, 'admin', 'plan-workspace-review', { planId: params.planId, previewId: params.previewId })
      requireCondition(preview.ok, 'REVISION_CONFLICT', 'Preview is stale; generate a new workspace preview')
      await confirm(`Preserve old files and branches, invalidate authorization and use a new workspace binding.\n${JSON.stringify(preview.data, null, 2)}`, params.planId); params.confirmation = params.planId
    }
    print(await invoke(state, identifier === 'configure' ? 'admin' : 'bridge', methods[identifier]!, params)); return
  }
  if (command === 'recover-lock') { await confirm('Confirm the old daemon is dead. This does not resolve uncertain tasks or kill processes.', 'recover-lock'); await recoverLock(state); print({ recovered: true }); return }
  if ((command === 'task' || command === 'plan') && identifier === 'delete') {
    const action = command === 'task' ? 'delete-task' : 'delete-plan'
    const params = deletionSchemas[action].parse(JSON.parse(values.json ?? '{}'))
    const target = 'ticketId' in params ? params.ticketId : params.planId
    await confirm(`Delete these records from active lists and scheduling. Audit snapshots, files, worktrees and remote MRs are retained. There is no UI undo.\n${JSON.stringify(params, null, 2)}`, target)
    const result = await invoke(state, 'admin', action, params)
    print(result); if (!result.ok) process.exitCode = 1; return
  }
  if (['task', 'plan', 'thread', 'event', 'route'].includes(command)) {
    requireCondition(identifier && /^[a-z_]+$/.test(identifier), 'INVALID_REQUEST', 'Specify create, list, get, message, start, stop, retry, resume or publish')
    const result = await invoke(state, 'bridge', `${command}_${identifier}`, JSON.parse(values.json ?? '{}'))
    print(result); if (!result.ok) process.exitCode = 1; return
  }
  if (command === 'status') { print(await invoke(state, 'bridge', 'health')); return }
  let method = command
  let params: unknown = {}
  if (command === 'approve' || command === 'decline') {
    requireCondition(process.stdin.isTTY && process.stdout.isTTY, 'FORBIDDEN', 'Human authorization requires an interactive terminal')
    requireCondition(identifier, 'INVALID_REQUEST', 'Approval ID required')
    const pending = await invoke(state, 'admin', 'approvals')
    requireCondition(pending.ok, 'RUNTIME_UNAVAILABLE', 'Cannot read pending approvals')
    const approval = (pending.data as { id: string; kind: string; details: { fingerprint?: string; preview?: { fingerprint: string } } }[]).find(entry => entry.id === identifier)
    requireCondition(approval, 'NOT_FOUND', 'Approval is no longer pending')
    await confirm(JSON.stringify(approval, null, 2), identifier)
    method = 'decide'; params = { id: identifier, accept: command === 'approve', ...(['publish', 'plan'].includes(approval.kind) && command === 'approve' ? { expectedFingerprint: approval.kind === 'plan' ? approval.details.fingerprint : approval.details.preview?.fingerprint } : {}) }
  } else if (command === 'pause' || command === 'unpause') { method = 'pause'; params = { paused: command === 'pause' } }
  else if (command === 'accept-result' || command === 'complete-plan') {
    const input = JSON.parse(values.json ?? '{}')
    const target = command === 'accept-result' ? input.ticketId : input.planId
    requireCondition(typeof target === 'string', 'INVALID_REQUEST', 'Provide the task or plan ID and expected revision')
    await confirm(`Inspect the actual results and evidence before accepting:\n${JSON.stringify(input, null, 2)}`, target)
    params = input
  }
  else if (command === 'publish-preview') { params = { id: identifier, authorName: values['author-name'], authorEmail: values['author-email'] } }
  else if (['inspect', 'complete', 'reconcile', 'observe', 'reconcile-publish'].includes(command)) {
    requireCondition(identifier, 'INVALID_REQUEST', 'Ticket ID required')
    if (['complete', 'reconcile', 'reconcile-publish'].includes(command)) await confirm(command.startsWith('reconcile') ? 'First inspect Codex thread history, owned process termination, workspace and external effects. Your note becomes audit evidence; pending will allow replay on explicit resume.' : 'Accept this local ready result as delivered, without a MR.', identifier)
    params = command === 'reconcile' ? { ticketId: identifier, note: values.note, disposition: values.disposition } : { ticketId: identifier }
  } else requireCondition(['approvals', 'backup', 'shutdown'].includes(command), 'INVALID_REQUEST', 'Unknown command; run help')
  const result = await invoke(state, 'admin', method, params)
  print(result); if (!result.ok) process.exitCode = 1
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Local command failed'}\n`); process.exitCode = 1 })
