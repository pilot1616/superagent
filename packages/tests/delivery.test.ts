import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { GitLabProject, Ticket } from '../core/src/model.js'
import { git, registerRepository, prepareWorkspace } from '../service/src/workspace.js'
import { Delivery } from '../integrations-gitlab/src/delivery.js'
import { type GitLabPort, type MergeRequestRecord, validateMergeRequest } from '../integrations-gitlab/src/api.js'
import { previewWorkspace } from '../integrations-gitlab/src/workspace.js'

async function fixture(project: GitLabProject = { url: 'https://gitlab.com', projectPath: 'example/fixture' }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-gh-')))
  const repositoryPath = join(root, 'repo')
  await git(root, ['init', '-b', 'main', repositoryPath])
  await writeFile(join(repositoryPath, 'README'), 'base\n')
  await git(repositoryPath, ['add', 'README'])
  await git(repositoryPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'])
  await git(repositoryPath, ['remote', 'add', 'origin', `${project.url}/${project.projectPath}.git`])
  const repository = await registerRepository(repositoryPath, join(root, 'worktrees'), 'main', project.url)
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
  for (const effect of store.effects('running')) store.saveEffect({ ...effect, state: 'done' })
  await writeFile(join(ticket.workspace!, 'README'), 'changed\n')
  await writeFile(join(ticket.workspace!, 'new.txt'), 'new file\n')
  let pushed = ''
  let createdCount = 0
  let remote: MergeRequestRecord | undefined
  const api: GitLabPort = {
    async find() { return remote ? [remote] : [] },
    async create() { createdCount++; remote = { iid: 1, project_id: 42, source_project_id: 42, target_project_id: 42, web_url: `${project.url}/${project.projectPath}/-/merge_requests/1`, state: 'opened', source_branch: ticket.branch!, target_branch: 'main', sha: pushed }; return remote },
    async read() { assert.ok(remote); return remote },
    async feedback() { return [{ key: 'review:1', text: 'Untrusted review request' }] },
  }
  const delivery = new Delivery(store, engine, root, api, async (_ticket, _preview, sha) => { pushed = sha })
  return { root, repository, store, engine, ticket, api, delivery, counts: () => ({ pushed, createdCount }), cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }) } }
}
for (const hasUncommittedChanges of [false, true]) test(`publication preserves Worker local commits${hasUncommittedChanges ? ' and commits subsequent reviewed edits' : ' without creating a duplicate commit'}`, async () => {
  const context = await fixture()
  const { engine, store, ticket, delivery, repository } = context
  try {
    await git(ticket.workspace!, ['add', '--', 'README', 'new.txt'])
    await git(ticket.workspace!, ['-c', 'user.name=Worker Fixture', '-c', 'user.email=worker@example.invalid', 'commit', '-m', 'Worker local result'])
    const localHead = await git(ticket.workspace!, ['rev-parse', 'HEAD'])
    if (hasUncommittedChanges) await writeFile(join(ticket.workspace!, 'new.txt'), 'follow-up local edit\n')
    const current = engine.require(ticket.id)
    assert.equal((await prepareWorkspace(repository, current)).workspace, ticket.workspace)
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: current.revision, headSha: localHead, requestId: randomUUID() })
    const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish')!
    const preview = await delivery.preview(approval.id, 'Test Author', 'test@example.invalid')
    assert.equal(preview.headSha, localHead)
    assert.match(preview.diff, /README/)
    assert.match(preview.diff, /new.txt/)
    await delivery.approve(approval.id, preview.fingerprint)
    const effect = store.effects('pending').find(entry => entry.kind === 'publish')!
    engine.claim(effect)
    await delivery.publish(effect)
    const published = context.counts().pushed
    assert.equal(context.counts().createdCount, 1)
    assert.equal(engine.require(ticket.id).mergeRequest?.headSha, published)
    assert.equal(await git(ticket.workspace!, ['rev-parse', 'HEAD']), published)
    if (hasUncommittedChanges) {
      assert.notEqual(published, localHead)
      assert.equal(await git(ticket.workspace!, ['rev-parse', 'HEAD^']), localHead)
      assert.equal(await git(ticket.workspace!, ['show', 'HEAD:new.txt']), 'follow-up local edit')
    } else assert.equal(published, localHead)
    assert.equal(await git(repository.path, ['rev-parse', 'main']), ticket.baseSha)
    assert.equal(await git(ticket.workspace!, ['status', '--porcelain']), '')
  } finally { await context.cleanup() }
})

test('publication preview covers untracked files, rejects mutation, publishes once, observes only bound MRs', async () => {
  const context = await fixture()
  const { engine, store, ticket, delivery, repository, root } = context
  try {
    const current = engine.require(ticket.id)
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: current.revision, headSha: await git(ticket.workspace!, ['rev-parse', 'HEAD']), requestId: randomUUID() })
    const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish')!
    const preview = await delivery.preview(approval.id, 'Test Author', 'test@example.invalid')
    assert.match(preview.diff, /new.txt/)
    await writeFile(join(ticket.workspace!, 'new.txt'), 'changed after approval preview')
    await assert.rejects(() => delivery.approve(approval.id, preview.fingerprint), /no longer matches/)
    const refreshed = await delivery.preview(approval.id, 'Test Author', 'test@example.invalid')
    await delivery.approve(approval.id, refreshed.fingerprint)
    const effect = store.effects('pending').find(entry => entry.kind === 'publish')!
    engine.claim(effect)
    await delivery.publish(effect)
    assert.equal(context.counts().createdCount, 1)
    assert.equal(engine.require(ticket.id).mergeRequest?.headSha, context.counts().pushed)
    assert.equal(await readFile(join(repository.path, 'README'), 'utf8'), 'base\n')
    assert.equal(await git(ticket.workspace!, ['status', '--porcelain']), '')
    store.saveEffect({ ...effect, state: 'done' })
    await delivery.observe(ticket.id)
    await delivery.observe(ticket.id)
    assert.equal(engine.require(ticket.id).inputs.filter(entry => entry.source === 'gitlab').length, 1)
    assert.match(engine.require(ticket.id).report?.question ?? '', /scope/)
    engine.call('task_stop', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID(), reason: 'Hold after MR' })
    await delivery.observe(ticket.id)
    assert.equal(engine.require(ticket.id).mandate.humanHold, true)
    await symlink('/etc/hosts', join(ticket.workspace!, 'unsafe-link'))
    await assert.rejects(() => previewWorkspace(repository, engine.require(ticket.id), root, 'Test', 'test@example.invalid'), /Symlinks/)
  } finally { await context.cleanup() }
})
test('MR ownership and uncertain delivery cannot be bypassed or replayed', async () => {
  const context = await fixture()
  try {
    const { engine, store, ticket, delivery, api } = context
    engine.call('task_publish', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, headSha: await git(ticket.workspace!, ['rev-parse', 'HEAD']), requestId: randomUUID() })
    const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish')!
    const preview = await delivery.preview(approval.id, 'Test', 'test@example.invalid')
    await delivery.approve(approval.id, preview.fingerprint)
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
    const record = await api.read(context.repository.gitlab!, 1)
    assert.throws(() => validateMergeRequest(record, { ...context.repository.gitlab!, projectPath: 'other/repo' }, ticket.branch!, 'main'), /does not match/)
  } finally { await context.cleanup() }
})

async function requestPublication(context: Awaited<ReturnType<typeof fixture>>) {
  const { engine, store, ticket, delivery } = context
  engine.call('task_publish', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, headSha: await git(ticket.workspace!, ['rev-parse', 'HEAD']), requestId: randomUUID() })
  const approval = store.approvals(ticket.id).find(entry => entry.kind === 'publish' && entry.status === 'pending')!
  const preview = await delivery.preview(approval.id, 'Test', 'test@example.invalid')
  return { approval, preview }
}

test('approval rejects a refreshed preview under the same ID until the displayed fingerprint is confirmed', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    await writeFile(join(context.ticket.workspace!, 'new.txt'), 'second preview\n')
    const refreshed = await context.delivery.preview(approval.id, 'Test', 'test@example.invalid')
    assert.notEqual(preview.fingerprint, refreshed.fingerprint)
    await assert.rejects(context.delivery.approve(approval.id, preview.fingerprint), /preview changed/)
    assert.throws(() => context.engine.authorizePublish(approval.id, refreshed, preview.fingerprint), /no longer matches/)
    assert.equal(context.store.effects('pending').length, 0)
    await context.delivery.approve(approval.id, refreshed.fingerprint)
    assert.equal((context.store.effects('pending')[0]!.payload.preview as typeof preview).fingerprint, refreshed.fingerprint)
  } finally { await context.cleanup() }
})

test('known preflight failures invalidate approval and permit a fresh publication without reconciliation', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    await context.delivery.approve(approval.id, preview.fingerprint)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    await writeFile(join(context.ticket.workspace!, 'new.txt'), 'changed after authorization\n')
    await assert.rejects(context.delivery.publish(effect), /contents changed/)
    context.engine.failPublication(effect.key, 'Contents changed before any delivery writes')
    assert.equal(context.store.approval(approval.id)!.status, 'expired')
    assert.equal(context.store.effects('uncertain').length, 0)
    assert.equal(context.engine.require(context.ticket.id).reconciliation, undefined)
    assert.deepEqual(context.counts(), { pushed: '', createdCount: 0 })
    const next = await requestPublication(context)
    await context.delivery.approve(next.approval.id, next.preview.fingerprint)
    const nextEffect = context.store.effects('pending')[0]!
    context.engine.claim(nextEffect)
    await context.delivery.publish(nextEffect)
    assert.equal(context.counts().createdCount, 1)
  } finally { await context.cleanup() }
})

test('local completion rejects pending approval, publication and input, including while MR lookup awaits', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    assert.throws(() => context.engine.complete(context.ticket.id), /pending inputs, approvals and operations/)
    await context.delivery.approve(approval.id, preview.fingerprint)
    assert.throws(() => context.engine.complete(context.ticket.id), /pending inputs, approvals and operations/)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    context.api.find = async () => {
      assert.throws(() => context.engine.complete(context.ticket.id), /pending inputs, approvals and operations/)
      return []
    }
    await context.delivery.publish(effect)
    assert.equal(context.engine.require(context.ticket.id).ended, undefined)
    assert.equal(context.engine.require(context.ticket.id).mergeRequest?.state, 'open')
  } finally { await context.cleanup() }
  const pending = await fixture()
  try {
    const { approval, preview } = await requestPublication(pending)
    await pending.delivery.approve(approval.id, preview.fingerprint)
    pending.engine.call('task_message', { ticketId: pending.ticket.id, expectedRevision: pending.engine.require(pending.ticket.id).revision, requestId: randomUUID(), text: 'Wait for another check' })
    const effect = pending.store.effects('pending')[0]!
    pending.store.saveEffect({ ...effect, state: 'done' })
    assert.throws(() => pending.engine.complete(pending.ticket.id), /pending inputs, approvals and operations/)
  } finally { await pending.cleanup() }
})

test('publication revalidates task revision after awaited MR lookup before committing', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    await context.delivery.approve(approval.id, preview.fingerprint)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    context.api.find = async () => {
      context.engine.call('task_message', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), text: 'New condition before delivery' })
      return []
    }
    await assert.rejects(context.delivery.publish(effect), /authorization changed/)
    assert.equal(await git(context.ticket.workspace!, ['rev-parse', 'HEAD']), preview.headSha)
    assert.equal(context.store.effects('running')[0]!.payload.phase, 'preflight')
    assert.deepEqual(context.counts(), { pushed: '', createdCount: 0 })
  } finally { await context.cleanup() }
})

test('post-commit uncertainty persists checkpoints and never becomes a safe preflight retry', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    await context.delivery.approve(approval.id, preview.fingerprint)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    const delivery = new Delivery(context.store, context.engine, context.root, context.api, async () => {
      context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Stop while push is pending' })
    })
    await assert.rejects(delivery.publish(effect), /authorization changed/)
    context.engine.failPublication(effect.key, 'Task stopped during push')
    const uncertain = context.store.effects('uncertain')[0]!
    assert.equal(uncertain.payload.phase, 'pushing')
    assert.equal(typeof uncertain.payload.committedSha, 'string')
    assert.equal(context.counts().createdCount, 0)
    assert.ok(context.engine.require(context.ticket.id).reconciliation)
    await assert.rejects(delivery.reconcile(context.ticket.id), /unique remote MR/)
  } finally { await context.cleanup() }
})

test('restart safely rejects interrupted preflight but retains legacy unknown publication for reconciliation', async () => {
  for (const legacy of [false, true]) {
    const context = await fixture()
    try {
      const { approval, preview } = await requestPublication(context)
      await context.delivery.approve(approval.id, preview.fingerprint)
      const effect = context.store.effects('pending')[0]!
      context.engine.claim(effect)
      if (legacy) {
        const persisted = context.store.effects('running')[0]!
        delete persisted.payload.phase
        context.store.saveEffect(persisted)
      }
      context.engine.recover()
      assert.equal(context.store.effects('uncertain').length, legacy ? 1 : 0)
      assert.equal(Boolean(context.engine.require(context.ticket.id).reconciliation), legacy)
      if (legacy) await assert.rejects(context.delivery.reconcile(context.ticket.id), /No persisted commit checkpoint/)
      else assert.equal(context.store.approval(approval.id)!.status, 'expired')
    } finally { await context.cleanup() }
  }
})

test('GitLab publication fingerprints bind host and namespace and reject destination substitution before I/O', async () => {
  const context = await fixture()
  try {
    const { approval, preview } = await requestPublication(context)
    assert.equal(preview.provider, 'gitlab')
    assert.deepEqual(preview.repository, { url: 'https://gitlab.com', projectPath: 'example/fixture' })
    await context.delivery.approve(approval.id, preview.fingerprint)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    const persisted = context.store.effects('running')[0]!
    context.store.saveEffect({ ...persisted, payload: { ...persisted.payload, preview: { ...preview, repository: { ...preview.repository, url: 'https://other-gitlab.example.test' } } } })
    context.api.find = async () => { throw new Error('Must not contact a substituted destination') }
    await assert.rejects(context.delivery.publish(effect), /registered GitLab host and project/)
    assert.deepEqual(context.counts(), { pushed: '', createdCount: 0 })
  } finally { await context.cleanup() }
})

test('self-managed subgroup delivery binds the correct MR and reconciles only its committed SHA', async () => {
  const project = { url: 'https://gitlab.example.test:8443', projectPath: 'team/subgroup/fixture' }
  const context = await fixture(project)
  try {
    const { approval, preview } = await requestPublication(context)
    assert.deepEqual(preview.repository, project)
    await context.delivery.approve(approval.id, preview.fingerprint)
    const effect = context.store.effects('pending')[0]!
    context.engine.claim(effect)
    await context.delivery.publish(effect)
    assert.equal(context.engine.require(context.ticket.id).mergeRequest?.url, `${project.url}/${project.projectPath}/-/merge_requests/1`)
    const checkpoint = context.store.effects('running')[0]!
    context.engine.failPublication(checkpoint.key, 'Fixture response lost after remote MR creation')
    const remote = await context.api.read(project, 1)
    const find = context.api.find
    context.api.find = async () => [{ ...remote, sha: 'f'.repeat(40) }]
    await assert.rejects(context.delivery.reconcile(context.ticket.id), /Remote head does not match/)
    context.api.find = find
    await context.delivery.reconcile(context.ticket.id)
    assert.equal(context.engine.require(context.ticket.id).reconciliation, undefined)
    assert.equal(context.counts().createdCount, 1)
  } finally { await context.cleanup() }
})

test('GitLab merged and closed MRs settle tasks but never release a human stop', async () => {
  for (const state of ['merged', 'closed'] as const) {
    const context = await fixture()
    try {
      const { approval, preview } = await requestPublication(context)
      await context.delivery.approve(approval.id, preview.fingerprint)
      const effect = context.store.effects('pending')[0]!
      context.engine.claim(effect)
      await context.delivery.publish(effect)
      const remote = await context.api.read(context.repository.gitlab!, 1)
      context.engine.syncMergeRequest(context.ticket.id, validateMergeRequest({ ...remote, state }, context.repository.gitlab!, context.ticket.branch!, 'main'))
      assert.equal(context.engine.require(context.ticket.id).ended, 'completed')
      context.engine.call('task_stop', { ticketId: context.ticket.id, expectedRevision: context.engine.require(context.ticket.id).revision, requestId: randomUUID(), reason: 'Keep held' })
      context.engine.syncMergeRequest(context.ticket.id, validateMergeRequest({ ...remote, state: state === 'merged' ? 'closed' : 'merged' }, context.repository.gitlab!, context.ticket.branch!, 'main'))
      assert.equal(context.engine.require(context.ticket.id).mandate.humanHold, true)
    } finally { await context.cleanup() }
  }
})
