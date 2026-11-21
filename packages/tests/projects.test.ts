import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ProjectSession, configureProjects, repositoryRoot } from '../service/src/projects.js'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { invoke } from '../service/src/ipc.js'
import { git } from '../service/src/workspace.js'
import { createProjectBridge } from '../mcp/src/bridge.js'

async function repository(root: string, name: string) {
  const path = join(root, name)
  await git(root, ['init', '-b', 'main', path])
  await writeFile(join(path, 'README'), `${name}\n`)
  await git(path, ['add', 'README'])
  await git(path, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
  return path
}
async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/sa-p-'))
  const host = join(root, 'h'), first = await repository(root, 'a'), second = await repository(root, 'b')
  const projects = []
  const services: Awaited<ReturnType<typeof startService>>[] = []
  for (const [index, path] of [first, second].entries()) {
    const state = join(root, `s${index}`)
    await initialize(state, path, join(root, `w${index}`), 'test-model', 'main')
    services.push(await startService(state))
    projects.push({ repositoryPath: path, state })
  }
  await configureProjects(host, { version: 1, defaultModel: 'test-model', projects })
  return { root, host, first, second, projects, services, async close() { for (const service of services) await service.close(); await rm(root, { recursive: true, force: true }) } }
}
async function connection(root: string, roots?: () => string[]) {
  const server = createProjectBridge(root)
  const client = new Client({ name: 'session-test', version: '1' }, roots ? { capabilities: { roots: { listChanged: true } } } : undefined)
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots().map(path => ({ uri: pathToFileURL(path).href })) }))
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, async call(name: string, args = {}) { const result = await client.callTool({ name: `superagent_${name}`, arguments: args }); return JSON.parse((result.content as { text: string }[])[0]!.text) }, async close() { await client.close(); await server.close() } }
}

test('two session bridges isolate current projects and never default to an imported instance', async () => {
  const context = await fixture()
  const first = await connection(context.host), second = await connection(context.host), same = await connection(context.host)
  try {
    assert.equal((await first.call('health')).error.code, 'PROJECT_REQUIRED')
    const tools = await first.client.listTools()
    assert.equal(tools.tools.length, 30)
    assert.ok(tools.tools.some(tool => tool.name === 'superagent_plan_workspace_preview'))
    assert.ok(tools.tools.some(tool => tool.name === 'superagent_task_workspace_prepare'))
    assert.equal(tools.tools.some(tool => /workspace.configure/.test(tool.name)), false)
    assert.equal(tools.tools.some(tool => /approve|decide/.test(tool.name)), false)
    await first.call('project_open', { repositoryPath: context.first })
    await second.call('project_open', { repositoryPath: context.second })
    const firstHealth = await first.call('health'), secondHealth = await second.call('health')
    assert.equal(firstHealth.data.repository.path, context.first)
    assert.equal(secondHealth.data.repository.path, context.second)
    const task = await first.call('task_create', { repositoryId: firstHealth.data.repository.id, title: 'Only project A', request: 'A scoped task', requestId: randomUUID() })
    assert.equal(task.ok, true)
    assert.equal((await second.call('task_list')).data.items.length, 0)
    assert.equal((await second.call('task_get', { ticketId: task.data.ticket.id })).ok, false)
    const reused = await same.call('project_open', { repositoryPath: context.first })
    assert.equal(reused.data.launched, false)
    assert.equal((await same.call('task_list')).data.items[0].id, task.data.ticket.id)
    assert.equal((await first.call('project_open', { repositoryPath: context.second })).error.code, 'PROJECT_BOUND')
  } finally { await first.close(); await second.close(); await same.close(); await context.close() }
})

test('host roots are checked before selection and every task call, while multiple roots require explicit choice', async () => {
  const context = await fixture()
  let roots = [context.first]
  const session = await connection(context.host, () => roots)
  try {
    assert.equal((await session.call('project_open', { repositoryPath: context.second })).error.code, 'PROJECT_MISMATCH')
    roots = [context.first, context.second]
    assert.equal((await session.call('health')).error.code, 'PROJECT_REQUIRED')
    assert.equal((await session.call('project_open', { repositoryPath: context.first })).ok, true)
    roots = [context.second]
    assert.equal((await session.call('task_list')).error.code, 'PROJECT_MISMATCH')
  } finally { await session.close(); await context.close() }
})

test('project setup requires explicit consent and model; canonical subdirectories resolve to the same Git root', async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-p-'))
  try {
    const repo = await repository(root, 'r')
    await mkdir(join(repo, 'subdirectory'))
    assert.equal(await repositoryRoot(join(repo, 'subdirectory')), repo)
    await assert.rejects(() => repositoryRoot('relative/path'), /absolute project path/)
    const session = new ProjectSession(join(root, 'h'), async () => undefined)
    await assert.rejects(() => session.select({ repositoryPath: repo }), /no service yet/)
    await assert.rejects(() => session.select({ repositoryPath: repo, initialize: true }), /explicit Worker model/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('wrong state mappings and unreachable locks cannot launch or route another repository', async () => {
  const context = await fixture()
  try {
    await writeFile(join(context.host, 'settings.json'), JSON.stringify({ version: 1, projects: [{ repositoryPath: context.second, state: context.projects[0]!.state }] }))
    const session = new ProjectSession(context.host, async () => undefined)
    await assert.rejects(() => session.select({ repositoryPath: context.second }), /another repository/)
    await context.services[0]!.close()
    await mkdir(join(context.projects[0]!.state, 'daemon.lock'))
    await assert.rejects(() => session.select({ repositoryPath: context.second }), /lock exists/)
    await rm(join(context.projects[0]!.state, 'daemon.lock'), { recursive: true })
    await assert.rejects(() => session.select({ repositoryPath: context.second }), /another project/)
  } finally { await context.close() }
})

test('session project setup starts its own service and private panel once across concurrent sessions', async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-p-'))
  let state: string | undefined
  try {
    const repo = await repository(root, 'r'), host = join(root, 'h')
    await configureProjects(host, { version: 1, defaultModel: 'test-model' })
    const first = new ProjectSession(host, async () => [repo]), second = new ProjectSession(host, async () => [repo])
    const values = await Promise.all([first.select({ repositoryPath: repo, initialize: true }), second.select({ repositoryPath: repo, initialize: true })])
    state = values[0]!.state
    assert.equal(values[1]!.state, state)
    assert.equal(values.filter(value => value.initialized).length, 1)
    assert.equal(values.filter(value => value.launched).length, 1)
    assert.equal(values[0]!.executionEnabled, false)
    assert.equal(values[0]!.dashboardUrl, values[1]!.dashboardUrl)
    assert.match(values[0]!.dashboardUrl!, /^http:\/\/127\.0\.0\.1:/)
    assert.equal((await fetch(values[0]!.dashboardUrl!)).status, 200)
    assert.equal((await stat(values[0]!.loginTokenFile)).mode & 0o777, 0o600)
    const token = await readFile(values[0]!.loginTokenFile, 'utf8')
    assert.equal((await readFile(join(state, 'daemon.log'), 'utf8')).includes(token), false)
    assert.equal((await first.state()), state)
  } finally {
    if (state) {
      await invoke(state, 'admin', 'shutdown')
      for (let attempt = 0; attempt < 100; attempt++) { try { await stat(join(state, 'daemon.lock')); await new Promise(resolve => setTimeout(resolve, 30)) } catch { break } }
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('project MCP mode does not use the bridge process cwd as the conversation project', async () => {
  const context = await fixture()
  const client = new Client({ name: 'cwd-test', version: '1' })
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/service/src/cli.js'), 'mcp', 'bridge', '--projects-root', context.host], cwd: context.second, stderr: 'pipe' }))
    const response = await client.callTool({ name: 'superagent_health', arguments: {} })
    assert.equal(JSON.parse((response.content as { text: string }[])[0]!.text).error.code, 'PROJECT_REQUIRED')
    const opened = await client.callTool({ name: 'superagent_project_open', arguments: { repositoryPath: context.first } })
    assert.equal(JSON.parse((opened.content as { text: string }[])[0]!.text).data.repository.path, context.first)
  } finally { await client.close(); await context.close() }
})
