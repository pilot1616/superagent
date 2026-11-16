import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { invoke } from '../service/src/ipc.js'
import { git } from '../service/src/workspace.js'
import type { Executor } from '../core/src/ports.js'
import type { Ticket } from '../core/src/model.js'

test('authenticated service, MCP transport, concurrency, backup and restart preserve manual holds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-')))
  const state = join(root, 's')
  const repository = join(root, 'r')
  await git(root, ['init', repository])
  await writeFile(join(repository, 'README'), 'fixture\n')
  await git(repository, ['add', 'README'])
  await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
  await initialize(state, repository, join(root, 'w'), 'test-model')
  let launched = 0
  let stopped = 0
  const active = new Map<string, Ticket>()
  const executor: Executor = { active, async launch(ticket) { launched++; active.set(ticket.id, ticket) }, async stop(id) { stopped++; active.delete(id); service.engine.stopped(id) }, async decideRuntime() { throw new Error('No live approvals') }, async shutdown() { active.clear() } }
  let service = await startService(state, () => executor)
  const client = new Client({ name: 'integration-test', version: '1' })
  try {
    await assert.rejects(() => startService(state, () => executor), /lock exists/)
    const denied = await invoke(state, 'bridge', 'decide', { id: 'fabricated', accept: true })
    assert.equal(denied.error?.code, 'FORBIDDEN')
    const unauthorized = await readFile(join(state, 'bridge.token'), 'utf8')
    await writeFile(join(state, 'bridge.token'), 'invalid')
    assert.equal((await invoke(state, 'bridge', 'health')).error?.code, 'UNAUTHENTICATED')
    await writeFile(join(state, 'bridge.token'), unauthorized)
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/service/src/cli.js'), 'mcp', 'bridge', '--state', state], stderr: 'pipe' })
    await client.connect(transport)
    const list = await client.listTools()
    assert.equal(list.tools.length, 10)
    assert.ok(!list.tools.some(tool => /approve|shell|sql/.test(tool.name)))
    const payload = { repositoryId: service.store.repository()!.id, title: 'Test task', request: 'Change fixture safely', requestId: randomUUID() }
    const created = await client.callTool({ name: 'superagent_task_create', arguments: payload })
    assert.equal(created.isError, false)
    const ticket = (created.structuredContent as any).data.ticket as Ticket
    assert.equal(launched, 0)
    const copies = await Promise.all(Array.from({ length: 8 }, () => invoke(state, 'bridge', 'task_create', payload)))
    assert.ok(copies.every(copy => (copy.data as any).ticket.id === ticket.id))
    assert.equal(service.store.tickets().length, 1)
    await invoke(state, 'bridge', 'task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    assert.equal(launched, 0)
    await invoke(state, 'admin', 'pause', { paused: true })
    await invoke(state, 'admin', 'decide', { id: service.store.approvals()[0]!.id, accept: true })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(launched, 0)
    await invoke(state, 'admin', 'pause', { paused: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(launched, 1)
    await invoke(state, 'bridge', 'task_stop', { ticketId: ticket.id, expectedRevision: service.engine.require(ticket.id).revision, requestId: randomUUID(), reason: 'Human stop' })
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(stopped, 1)
    assert.equal(service.engine.require(ticket.id).ended, 'stopped')
    assert.equal((await invoke(state, 'admin', 'backup')).ok, true)
    await client.close()
    await service.close()
    service = await startService(state, () => executor)
    assert.equal(service.engine.require(ticket.id).mandate.humanHold, true)
    assert.equal(service.engine.require(ticket.id).ended, 'stopped')
  } finally { await client.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
