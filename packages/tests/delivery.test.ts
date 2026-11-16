import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { Ticket } from '../core/src/model.js'
import { git, registerRepository, prepareWorkspace } from '../service/src/workspace.js'
import { Delivery } from '../integrations-github/src/delivery.js'
import { type GitHubPort, type PullRecord, validatePull } from '../integrations-github/src/api.js'
import { previewWorkspace } from '../integrations-github/src/workspace.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-gh-')))
  const repositoryPath = join(root, 'repo')
  await git(root, ['init', '-b', 'main', repositoryPath])
  await writeFile(join(repositoryPath, 'README'), 'base\n')
  await git(repositoryPath, ['add', 'README'])
  await git(repositoryPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'])
  await git(repositoryPath, ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
  const repository = await registerRepository(repositoryPath, join(root, 'worktrees'), 'main')
  const store = new Store(':memory:')
  store.set('repository', repository)
  const engine = new Engine(store, 'human')
  const created = engine.call('task_create', { repositoryId: repository.id, title: 'Fixture change', request: 'Test controlled delivery', requestId: randomUUID() }) as { ticket: Ticket }
  engine.call('task_start', { ticketId: created.ticket.id, expectedRevision: 1, requestId: randomUUID() })
  engine.approve(store.approvals()[0]!.id, true)
  const ticket = engine.claim(store.effects('pending')[0]!)!
  Object.assign(ticket, await prepareWorkspace(repository, ticket))
  for (const entry of ticket.inputs) entry.state = 'accepted'
  store.save(ticket)
  engine.report(ticket.id, ticket.assignments[0]!.id, { state: 'ready', summary: 'Fixture ready', checks: ['fixture checks'] })
  await writeFile(join(ticket.workspace!, 'README'), 'changed\n')
  await writeFile(join(ticket.workspace!, 'new.txt'), 'new file\n')
  let pushed = ''
  let createdCount = 0
  let remote: PullRecord | undefined
  const api: GitHubPort = {
    async find() { return remote ? [remote] : [] },
    async create() { createdCount++; remote = { number: 1, html_url: 'https://github.com/example/fixture/pull/1', state: 'open', merged_at: null, head: { ref: ticket.branch!, sha: pushed, repo: { full_name: 'example/fixture' } }, base: { ref: 'main', repo: { full_name: 'example/fixture' } } }; return remote },
    async read() { assert.ok(remote); return remote },
    async feedback() { return [{ key: 'review:1', text: 'Untrusted review request' }] },
  }
  const delivery = new Delivery(store, engine, root, api, async (_ticket, _preview, sha) => { pushed = sha })
  return { root, repository, store, engine, ticket, api, delivery, counts: () => ({ pushed, createdCount }), cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }) } }
}
test('publication preview covers untracked files, rejects mutation, publishes once, observes only bound PRs', async () => {
  const context = await fixture()
  const { engine, store, ticket, delivery, repository, root } = context
  try {
    const current = engine.require(ticket.id)
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: current.revision, headSha: await git(ticket.workspace!, ['rev-parse', 'HEAD']), requestId: randomUUID() })
    const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish')!
    const preview = await delivery.preview(approval.id, 'Test Author', 'test@example.invalid')
    assert.match(preview.diff, /new.txt/)
    await writeFile(join(ticket.workspace!, 'new.txt'), 'changed after approval preview')
    await assert.rejects(() => delivery.approve(approval.id), /no longer matches/)
    await delivery.preview(approval.id, 'Test Author', 'test@example.invalid')
    await delivery.approve(approval.id)
    const effect = store.effects('pending').find(entry => entry.kind === 'publish')!
    engine.claim(effect)
    await delivery.publish(effect)
    assert.equal(context.counts().createdCount, 1)
    assert.equal(engine.require(ticket.id).pull?.headSha, context.counts().pushed)
    assert.equal(await readFile(join(repository.path, 'README'), 'utf8'), 'base\n')
    assert.equal(await git(ticket.workspace!, ['status', '--porcelain']), '')
    store.saveEffect({ ...effect, state: 'done' })
    await delivery.observe(ticket.id)
    await delivery.observe(ticket.id)
    assert.equal(engine.require(ticket.id).inputs.filter(entry => entry.source === 'github').length, 1)
    assert.match(engine.require(ticket.id).report?.question ?? '', /scope/)
    engine.call('task_stop', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID(), reason: 'Hold after PR' })
    await delivery.observe(ticket.id)
    assert.equal(engine.require(ticket.id).mandate.humanHold, true)
    await symlink('/etc/hosts', join(ticket.workspace!, 'unsafe-link'))
    await assert.rejects(() => previewWorkspace(repository, engine.require(ticket.id), root, 'Test', 'test@example.invalid'), /Symlinks/)
  } finally { await context.cleanup() }
})
test('PR ownership and uncertain delivery cannot be bypassed or replayed', async () => {
  const context = await fixture()
  try {
    const { engine, store, ticket, delivery, api } = context
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, headSha: await git(ticket.workspace!, ['rev-parse', 'HEAD']), requestId: randomUUID() })
    const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish')!
    await delivery.preview(approval.id, 'Test', 'test@example.invalid')
    await delivery.approve(approval.id)
    const effect = store.effects('pending').find(entry => entry.kind === 'publish')!
    engine.claim(effect)
    await delivery.publish(effect)
    const checkpoint = store.effects().find(entry => entry.key === effect.key)!
    store.saveEffect({ ...checkpoint, state: 'uncertain' })
    const current = engine.require(ticket.id)
    current.reconciliation = 'Response lost'
    store.save(current)
    await delivery.reconcile(ticket.id)
    assert.equal(engine.require(ticket.id).reconciliation, undefined)
    assert.equal(context.counts().createdCount, 1)
    const record = await api.read('example/fixture', 1)
    assert.throws(() => validatePull(record, 'other/repo', ticket.branch!, 'main'), /does not match/)
  } finally { await context.cleanup() }
})
