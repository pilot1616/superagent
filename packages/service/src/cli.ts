#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { defaultState, initialize, readConfig, recoverLock } from './config.js'
import { invoke } from './ipc.js'
import { startService } from './daemon.js'
import { acceptance, executionVerified } from '../../executor-codex/src/acceptance.js'
import { codexVersion, SUPPORTED_CODEX } from '../../executor-codex/src/probe.js'
import { bridge } from '../../mcp/src/bridge.js'
import { startPanel } from './panel.js'
import { requireCondition } from '../../core/src/model.js'

const HELP = `superagent-local — local, manual, single-repository task service

init --repo PATH --worktrees PATH --model NAME [--base HEAD] [--state PATH]
serve [--state PATH]                       Foreground daemon; no automatic login/start
status | doctor | approvals                Read service or compatibility information
panel [--port NUMBER]                      Read-only loopback dashboard; terminal login token
task OPERATION --json '{...}'               Public task operation; requestId required for writes
approve ID | decline ID                    Interactive human approval; no approve-all
pause | unpause | backup | shutdown         Trusted administrative operations
inspect TICKET                            Inspect a managed workspace without publication
publish-preview ID --author-name NAME --author-email EMAIL
observe TICKET | reconcile-publish TICKET  Read only the task's bound PR / reconcile delivery
complete TICKET                           Accept local work without a PR
reconcile TICKET --note TEXT --disposition pending|settled
recover-lock                              Remove a lock only after its owner is dead
mcp bridge                                Stdio MCP transport; does not start the daemon

Worker execution remains disabled until P0 acceptance passes. No automatic remote,
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
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { state: { type: 'string' }, repo: { type: 'string' }, worktrees: { type: 'string' }, model: { type: 'string' }, base: { type: 'string' }, json: { type: 'string' }, note: { type: 'string' }, disposition: { type: 'string' }, 'author-name': { type: 'string' }, 'author-email': { type: 'string' }, port: { type: 'string' } } })
  const [command, identifier] = positionals
  const state = resolve(values.state ?? defaultState())
  if (!command || command === 'help') { process.stdout.write(HELP); return }
  if (command === 'mcp' && identifier === 'bridge') { await bridge(state); return }
  if (command === 'panel') {
    requireCondition(process.stdout.isTTY, 'FORBIDDEN', 'Start the panel from a trusted terminal; login tokens must not enter model context')
    const port = Number(values.port ?? 0)
    requireCondition(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_REQUEST', 'Invalid port')
    await readConfig(state)
    const panel = await startPanel(state, port)
    process.stdout.write(`Read-only dashboard: ${panel.origin}\nEnter this token in the login form, not in the URL: ${panel.loginSecret}\n`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void panel.close() })
    return
  }
  if (command === 'init') {
    requireCondition(values.repo && values.worktrees && values.model, 'INVALID_REQUEST', 'init requires --repo, --worktrees and an explicit --model')
    await initialize(state, values.repo, values.worktrees, values.model, values.base)
    print({ initialized: true, state, executionEnabled: false }); return
  }
  if (command === 'serve') {
    const service = await startService(state)
    process.stderr.write(`Superagent listening at ${state}/service.sock; Worker gate: ${executionVerified()}\n`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().catch(() => { process.exitCode = 1 }) })
    return
  }
  if (command === 'doctor') {
    let version: string | undefined
    try { version = codexVersion('codex') } catch {}
    const config = await readConfig(state)
    print({ node: process.version, codex: version, supported: version === SUPPORTED_CODEX, config, acceptance, executionEnabled: executionVerified() }); return
  }
  if (command === 'recover-lock') { await confirm('Confirm the old daemon is dead. This does not resolve uncertain tasks or kill processes.', 'recover-lock'); await recoverLock(state); print({ recovered: true }); return }
  if (command === 'task') {
    requireCondition(identifier && /^[a-z_]+$/.test(identifier), 'INVALID_REQUEST', 'Specify create, list, get, message, start, stop, retry, resume or publish')
    const result = await invoke(state, 'bridge', `task_${identifier}`, JSON.parse(values.json ?? '{}'))
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
    const approval = (pending.data as { id: string }[]).find(entry => entry.id === identifier)
    requireCondition(approval, 'NOT_FOUND', 'Approval is no longer pending')
    await confirm(JSON.stringify(approval, null, 2), identifier)
    method = 'decide'; params = { id: identifier, accept: command === 'approve' }
  } else if (command === 'pause' || command === 'unpause') { method = 'pause'; params = { paused: command === 'pause' } }
  else if (command === 'publish-preview') { params = { id: identifier, authorName: values['author-name'], authorEmail: values['author-email'] } }
  else if (['inspect', 'complete', 'reconcile', 'observe', 'reconcile-publish'].includes(command)) {
    requireCondition(identifier, 'INVALID_REQUEST', 'Ticket ID required')
    if (['complete', 'reconcile', 'reconcile-publish'].includes(command)) await confirm(command.startsWith('reconcile') ? 'First inspect Codex thread history, owned process termination, workspace and external effects. Your note becomes audit evidence; pending will allow replay on explicit resume.' : 'Accept this local ready result as delivered, without a PR.', identifier)
    params = command === 'reconcile' ? { ticketId: identifier, note: values.note, disposition: values.disposition } : { ticketId: identifier }
  } else requireCondition(['approvals', 'backup', 'shutdown'].includes(command), 'INVALID_REQUEST', 'Unknown command; run help')
  const result = await invoke(state, 'admin', method, params)
  print(result); if (!result.ok) process.exitCode = 1
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Local command failed'}\n`); process.exitCode = 1 })
