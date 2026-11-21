import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { Ticket } from '../core/src/model.js'
import { TaskMaterials, executionMaterials } from '../service/src/materials.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(homedir(), '.sa-ref-test-')))
  const state = join(root, 's'), source = join(root, 'reference.pdf'), worktrees = join(root, 'w')
  await mkdir(state); await mkdir(worktrees)
  await writeFile(source, 'Synthetic reference, not a real PDF\n')
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo', path: join(root, 'repo'), executionRoot: worktrees })
  const engine = new Engine(store, 'human')
  const ticket = (engine.call('task_create', { repositoryId: 'repo', title: 'Reference fixture', request: 'Use only explicitly reviewed references', requestId: randomUUID() }) as { ticket: Ticket }).ticket
  const active = new Map<string, unknown>()
  const materials = new TaskMaterials(state, store, engine, () => active)
  const preview = () => materials.preview({ ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, paths: [source] })
  const params = (value: Awaited<ReturnType<typeof preview>>) => ({ ticketId: ticket.id, expectedRevision: value.revision, previewId: value.id, requestId: randomUUID(), confirmation: ticket.id })
  return { root, state, source, worktrees, store, engine, ticket, active, materials, preview, params, close: async () => { store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('reference attach is reviewed, idempotent, task-local and never authorizes execution', async () => {
  const context = await fixture()
  try {
    const preview = await context.preview()
    assert.equal(context.materials.list({ ticketId: context.ticket.id }).files.length, 0)
    const params = context.params(preview)
    const result = await context.materials.attach(params) as any
    assert.deepEqual(await context.materials.attach(params), result)
    assert.equal(result.executionStarted, false)
    assert.equal(context.engine.require(context.ticket.id).mandate.executionGranted, false)
    assert.equal(context.store.effects().length, 0)
    assert.equal(context.engine.require(context.ticket.id).restartThread, true)
    await writeFile(context.source, 'source changed')
    const current = await executionMaterials(context.state, context.store, context.ticket.id)
    assert.equal(current.files.length, 1)
    assert.match(await readFile(current.files[0]!.path, 'utf8'), /Synthetic reference/)
    assert.equal((await executionMaterials(context.state, context.store, randomUUID())).readRoots.length, 0)
    await chmod(current.files[0]!.path, 0o600)
    await writeFile(current.files[0]!.path, 'tampered')
    await assert.rejects(executionMaterials(context.state, context.store, context.ticket.id), /snapshot changed/)
    await assert.rejects(context.materials.attach({ ...params, confirmation: randomUUID() }), { code: 'FORBIDDEN' })
    await assert.rejects(context.materials.attach({ ...params, previewId: randomUUID() }), { code: 'REVISION_CONFLICT' })
  } finally { await context.close() }
})

test('reference previews reject changed content, changed task revisions and unreviewed requests', async () => {
  const context = await fixture()
  try {
    const first = await context.preview()
    await writeFile(context.source, 'changed after preview')
    await assert.rejects(context.materials.attach(context.params(first)), /content changed/)
    assert.equal(context.materials.list({ ticketId: context.ticket.id }).files.length, 0)
    const second = await context.preview()
    context.engine.call('task_message', { ticketId: context.ticket.id, expectedRevision: context.ticket.revision, requestId: randomUUID(), text: 'New requirement' })
    await assert.rejects(context.materials.attach(context.params(second)), { code: 'REVISION_CONFLICT' })
    const third = await context.preview()
    context.materials.clear()
    await assert.rejects(context.materials.attach(context.params(third)), /expired or changed/)
  } finally { await context.close() }
})

test('references reject credentials, other task workspaces, directories and active or pending tasks', async () => {
  const context = await fixture()
  try {
    await writeFile(join(context.state, 'admin.token'), 'fixture-not-a-real-token')
    await writeFile(join(context.worktrees, 'foreign.txt'), 'another task')
    for (const path of [join(context.state, 'admin.token'), join(context.worktrees, 'foreign.txt'), context.root]) await assert.rejects(context.materials.preview({ ticketId: context.ticket.id, expectedRevision: context.ticket.revision, paths: [path] }), { code: 'FORBIDDEN' })
    context.active.set(context.ticket.id, {})
    await assert.rejects(context.preview(), /Stop or finish/)
    context.active.clear()
    context.engine.call('task_start', { ticketId: context.ticket.id, expectedRevision: context.ticket.revision, requestId: randomUUID() })
    context.engine.approve(context.store.approvals()[0]!.id, true)
    await assert.rejects(context.preview(), /Stop or finish/)
  } finally { await context.close() }
})

test('expired reference previews and temporary control-state storage are rejected', async () => {
  const context = await fixture()
  const temporary = await realpath(await mkdtemp('/tmp/sa-ref-state-'))
  try {
    const preview = await context.preview()
    const now = Date.now()
    const clock = mock.method(Date, 'now', () => now + 300001)
    try { await assert.rejects(context.materials.attach(context.params(preview)), /expired or changed/) } finally { clock.mock.restore() }
    const unsafe = new TaskMaterials(temporary, context.store, context.engine, () => new Map())
    await assert.rejects(unsafe.preview({ ticketId: context.ticket.id, expectedRevision: context.ticket.revision, paths: [context.source] }), /outside system temporary/)
  } finally { await context.close(); await rm(temporary, { recursive: true, force: true }) }
})

test('concurrent duplicate reference delivery commits once and records only one snapshot', async () => {
  const context = await fixture()
  try {
    const preview = await context.preview()
    const params = context.params(preview)
    const results = await Promise.all([context.materials.attach(params), context.materials.attach(params)])
    assert.deepEqual(results[0], results[1])
    assert.equal(context.materials.list({ ticketId: context.ticket.id }).files.length, 1)
    await executionMaterials(context.state, context.store, context.ticket.id)
  } finally { await context.close() }
})
