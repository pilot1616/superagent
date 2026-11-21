import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../core/src/engine.js'
import { DomainError, latestAssignment, type Plan, type Ticket } from '../core/src/model.js'
import { candidates } from '../core/src/scheduler.js'
import { workspaceBinding } from '../core/src/workspace.js'
import { Store } from '../storage/src/store.js'
import { PlanWorkspaces } from '../service/src/plan-workspaces.js'
import { git, registerRepository, prepareWorkspace, verifyAcceptedCode } from '../service/src/workspace.js'
import { previewWorkspace } from '../integrations-gitlab/src/workspace.js'
import { Delivery } from '../integrations-gitlab/src/delivery.js'
import type { GitLabPort } from '../integrations-gitlab/src/api.js'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { invoke } from '../service/src/ipc.js'
import { setTimeout as delay } from 'node:timers/promises'
import { deleteRecords } from '../core/src/deletion.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-pw-')))
  const repo = join(root, 'repo')
  await git(root, ['init', '-b', 'main', repo])
  await writeFile(join(repo, 'file.txt'), 'main\n')
  await git(repo, ['add', '.'])
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'main'])
  const mainSha = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['checkout', '-b', 'insight-v1'])
  await writeFile(join(repo, 'file.txt'), 'insight-v1\n')
  await git(repo, ['add', '.'])
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'v1'])
  const v1Sha = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['update-ref', 'refs/remotes/origin/insight-v1', v1Sha])
  await git(repo, ['update-ref', 'refs/remotes/origin/main', mainSha])
  await git(repo, ['checkout', 'main'])
  await git(repo, ['remote', 'add', 'origin', 'https://gitlab.com/fixture/project.git'])
  const repository = await registerRepository(repo, join(root, 'work'), 'HEAD')
  const store = new Store(':memory:')
  store.set('repository', repository)
  const engine = new Engine(store, 'human')
  const active = new Set<string>(), jobs = new Set<string>()
  const controller = new PlanWorkspaces(store, engine, () => active, () => jobs)
  const create = (overrides: Record<string, unknown> = {}) => engine.call('plan_create', {
    repositoryId: repository.id, title: 'Goal', tasks: [{ key: 'work', title: 'Work', request: 'Implement work' }, { key: 'integration', title: 'Integration', request: 'Review result' }],
    dependencies: [{ before: 'work', after: 'integration', condition: 'artifact' }], integrationKey: 'integration', maxAttempts: 5,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID(), ...overrides,
  }) as { plan: Plan; mapping: Record<string, string> }
  const authorize = (id: string) => {
    const plan = store.entity<Plan>('plan', id)!
    engine.call('plan_start', { planId: id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = store.approvals(id).find(entry => entry.status === 'pending')!
    engine.approve(approval.id, true, String(approval.details.fingerprint))
    return approval
  }
  const preview = (id: string, baseRef = 'refs/remotes/origin/main') => controller.preview({ planId: id, expectedRevision: store.entity<Plan>('plan', id)!.revision, repositoryId: repository.id, baseRef, branchPrefix: 'superagent' })
  const configure = (value: Awaited<ReturnType<typeof preview>>) => controller.configure({ planId: value.planId, expectedRevision: value.revision, previewId: value.id, requestId: randomUUID(), confirmation: value.planId })
  const prepare = (id: string) => controller.prepare({ ticketId: id, expectedRevision: engine.require(id).revision }) as Promise<{ ready: boolean; code?: string; reason?: string }>
  return { root, repo, repository, mainSha, v1Sha, store, engine, active, jobs, controller, create, authorize, preview, configure, prepare, close: async () => { store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('two plans use independent pinned baselines, worktrees, approval fingerprints and GitLab targets', async () => {
  const context = await fixture()
  try {
    for (const branch of ['main', 'insight-v1']) {
      const { plan, mapping } = context.create()
      const preview = await context.preview(plan.id, `refs/remotes/origin/${branch}`)
      await context.configure(preview)
      const bound = context.store.entity<Plan>('plan', plan.id)!
      const approval = context.authorize(plan.id)
      assert.deepEqual((approval.details.spec as any).workspace, bound.workspace)
      assert.equal((await context.prepare(mapping.work!)).ready, true)
      const ticket = context.engine.require(mapping.work!)
      assert.equal(ticket.baseSha, branch === 'main' ? context.mainSha : context.v1Sha)
      assert.equal(await readFile(join(ticket.workspace!, 'file.txt'), 'utf8'), `${branch}\n`)
      assert.equal(ticket.workspace, join(context.repository.executionRoot, `${ticket.id}-${bound.workspace!.id}`))
      assert.equal(ticket.branch, `superagent/${bound.workspace!.id}/${ticket.id}`)
      await writeFile(join(ticket.workspace!, 'change.txt'), 'change\n')
      const publication = await previewWorkspace(context.repository, ticket, context.root, 'Test', 'test@invalid')
      assert.equal(publication.baseRef, branch)
      assert.equal(publication.baseSha, ticket.baseSha)
    }
    assert.equal(context.store.repository()!.baseRef, 'HEAD')
    assert.equal(await git(context.repo, ['branch', '--show-current']), 'main')
    assert.equal(await git(context.repo, ['status', '--porcelain']), '')
  } finally { await context.close() }
})

test('migration retains dirty legacy workspaces and history, clears thread binding and invalidates authorization', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    context.authorize(plan.id)
    const ticket = context.engine.require(mapping.work!)
    const prepared = await prepareWorkspace(context.repository, ticket)
    Object.assign(ticket, prepared)
    ticket.binding = { threadId: 'old-thread', version: 'fixture', profileHash: 'fixture' }
    ticket.inputs[0]!.state = 'settled'
    ticket.report = { state: 'blocked', summary: 'Old baseline mismatch', checks: [] }
    context.store.save(ticket)
    await writeFile(join(prepared.workspace, 'file.txt'), 'human edits\n')
    await writeFile(join(prepared.workspace, 'untracked.txt'), 'keep\n')
    const held = context.engine.require(mapping.integration!)
    held.mandate.humanHold = true
    context.store.save(held)
    const preview = await context.preview(plan.id, 'refs/remotes/origin/insight-v1')
    const params = { planId: plan.id, expectedRevision: preview.revision, previewId: preview.id, requestId: randomUUID(), confirmation: plan.id }
    const migrated = await context.controller.configure(params) as any
    assert.deepEqual(await context.controller.configure(params), migrated)
    await assert.rejects(context.controller.configure({ ...params, confirmation: 'wrong' }), /请求 ID/)
    const current = context.engine.require(ticket.id)
    assert.equal(current.workspace, undefined)
    assert.equal(current.binding, undefined)
    assert.equal(current.restartThread, true)
    assert.equal(current.mandate.executionGranted, false)
    assert.equal(current.inputs[0]!.state, 'pending')
    assert.equal(current.assignments.length, ticket.assignments.length)
    assert.equal(latestAssignment(current)!.state, 'ended')
    assert.equal(context.store.entity<Plan>('plan', plan.id)!.grant, undefined)
    assert.equal(candidates(context.store, new Set(), new Set(), 2).length, 0)
    const archive = context.store.entity<any>('workspace_archive', migrated.archiveId)
    assert.equal(archive.tickets.find((entry: Ticket) => entry.id === ticket.id).binding.threadId, 'old-thread')
    assert.equal(await readFile(join(prepared.workspace, 'file.txt'), 'utf8'), 'human edits\n')
    assert.equal(await readFile(join(prepared.workspace, 'untracked.txt'), 'utf8'), 'keep\n')
    context.authorize(plan.id)
    assert.equal(context.engine.require(held.id).mandate.humanHold, true)
    assert.equal((await context.prepare(ticket.id)).ready, true)
    assert.notEqual(context.engine.require(ticket.id).workspace, prepared.workspace)
    assert.equal(await git(prepared.workspace, ['branch', '--show-current']), prepared.branch)
  } finally { await context.close() }
})

test('migration preserves exhausted budgets and offers explicit extra-attempt recovery instead of an unstartable queue', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create({ maxAttempts: 1 })
    context.authorize(plan.id)
    const before = context.engine.require(mapping.work!)
    await context.configure(await context.preview(plan.id, 'refs/remotes/origin/insight-v1'))
    context.authorize(plan.id)
    const ticket = context.engine.require(mapping.work!)
    assert.equal(ticket.assignments.length, before.assignments.length)
    assert.equal(latestAssignment(ticket)!.state, 'ended')
    assert.equal(context.engine.view(ticket).stage, 'waiting')
    assert.equal(context.engine.view(ticket).retryBudget!.requiresApproval, true)
    context.engine.call('task_resume', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    const approval = context.store.approvals(ticket.id).find(entry => entry.status === 'pending')!
    assert.equal(approval.details.extraAttempt, true)
    assert.equal(approval.details.generation, 2)
    context.engine.approve(approval.id, true)
    assert.equal((await context.prepare(ticket.id)).ready, true)
    assert.equal(context.store.entity<Plan>('plan', plan.id)!.maxAttempts, 1)
  } finally { await context.close() }
})

test('expired previews and failed migration transactions do not revoke authorization or leave partial bindings', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    context.authorize(plan.id)
    const expired = await context.preview(plan.id)
    context.store.saveEntity('workspace_preview', expired.id, { ...expired, expiresAt: 1 })
    await assert.rejects(context.configure(expired), /预览失效/)
    const preview = await context.preview(plan.id, 'refs/remotes/origin/insight-v1')
    const previousPlan = context.store.entity<Plan>('plan', plan.id)!
    const previousTickets = previousPlan.ticketIds.map(id => context.engine.require(id))
    const save = context.store.save.bind(context.store)
    context.store.save = ticket => { if (ticket.id === mapping.integration) throw new Error('test storage failure'); save(ticket) }
    await assert.rejects(context.configure(preview), /test storage failure/)
    context.store.save = save
    assert.deepEqual(context.store.entity<Plan>('plan', plan.id), previousPlan)
    assert.deepEqual(previousPlan.ticketIds.map(id => context.engine.require(id)), previousTickets)
    assert.equal(context.store.entities('workspace_archive').length, 0)
    assert.ok(context.store.effects('pending').length)
    await context.configure(preview)
    assert.equal(context.store.entities('workspace_archive').length, 1)
  } finally { await context.close() }
})

test('missing workspace prerequisites block dispatch before claim and allow a controlled recovery', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.configure(await context.preview(plan.id))
    context.authorize(plan.id)
    const ticket = context.engine.require(mapping.work!)
    const branch = `${ticket.workspaceBinding!.branchPrefix}/${ticket.workspaceBinding!.id}/${ticket.id}`
    await git(context.repo, ['branch', branch, context.mainSha])
    const effect = context.store.effects('pending').find(entry => entry.ticketId === ticket.id)!
    const failed = await context.prepare(ticket.id)
    assert.equal(failed.ready, false)
    assert.equal(context.engine.view(context.engine.require(ticket.id)).scheduling.state, 'waiting_workspace')
    assert.equal(context.engine.claim(effect), undefined)
    assert.equal(context.store.effects().find(entry => entry.key === effect.key)!.attempts, 0)
    assert.equal(latestAssignment(context.engine.require(ticket.id))!.startedAt, undefined)
    const attention = context.engine.call('task_list', { view: 'attention' }) as any
    assert.ok(attention.items.some((entry: any) => entry.id === ticket.id))
    await git(context.repo, ['branch', '-D', branch])
    const recovered = await context.prepare(ticket.id)
    assert.equal(recovered.ready, true)
    assert.equal(context.store.get(`workspace:blocker:${ticket.id}`), null)
    assert.ok(context.engine.claim(effect))
    assert.equal(context.store.effects().find(entry => entry.key === effect.key)!.attempts, 1)
  } finally { await context.close() }
})

test('configuration rejection retains verified ownership so review can repair without overwriting files', async () => {
  const context = await fixture()
  try {
    await mkdir(join(context.repo, '.codex'))
    await writeFile(join(context.repo, '.codex', 'config.toml'), 'fixture = true\n')
    await git(context.repo, ['add', '.'])
    await git(context.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'configuration'])
    const { plan, mapping } = context.create()
    await context.configure(await context.preview(plan.id, 'refs/heads/main'))
    context.authorize(plan.id)
    assert.equal((await context.prepare(mapping.work!)).ready, false)
    const ticket = context.engine.require(mapping.work!)
    assert.ok(ticket.workspace)
    assert.equal(latestAssignment(ticket)!.startedAt, undefined)
    await rm(join(ticket.workspace!, '.codex'), { recursive: true })
    await writeFile(join(ticket.workspace!, 'review.txt'), 'explicit review\n')
    assert.equal((await context.prepare(ticket.id)).ready, true)
    assert.equal(await readFile(join(ticket.workspace!, 'review.txt'), 'utf8'), 'explicit review\n')
  } finally { await context.close() }
})

test('plan configuration rejects foreign repositories, stale revisions, moved refs and unconfirmed previews', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await assert.rejects(context.controller.preview({ planId: plan.id, expectedRevision: plan.revision, repositoryId: 'foreign', baseRef: 'refs/heads/main', branchPrefix: 'superagent' }), /当前项目/)
    await assert.rejects(context.preview(plan.id, 'main'))
    await assert.rejects(context.preview(plan.id, 'refs/heads/missing'), /本地分支引用/)
    const preview = await context.preview(plan.id)
    const params = { planId: plan.id, expectedRevision: preview.revision, previewId: preview.id, requestId: randomUUID(), confirmation: plan.id }
    await assert.rejects(context.controller.configure({ ...params, confirmation: 'no' }), /完整计划 ID/)
    await git(context.repo, ['update-ref', 'refs/remotes/origin/main', context.v1Sha])
    await assert.rejects(context.controller.configure(params), /引用已移动/)
    const next = await context.preview(plan.id)
    context.engine.call('task_message', { ticketId: mapping.work, expectedRevision: context.engine.require(mapping.work!).revision, text: 'New detail', requestId: randomUUID() })
    await assert.rejects(context.configure(next), /成员已变化/)
    const stale = await context.preview(plan.id)
    context.engine.call('plan_pause', { planId: plan.id, expectedRevision: stale.revision, paused: true, requestId: randomUUID() })
    await assert.rejects(context.configure(stale), /计划已变化/)
    assert.equal(context.store.entities('workspace_archive').length, 0)
  } finally { await context.close() }
})

for (const kind of ['active', 'job', 'running', 'reconciliation', 'agent', 'publish', 'result', 'mr']) {
  test(`workspace migration refuses unsafe member state: ${kind}`, async () => {
    const context = await fixture()
    try {
      const { plan, mapping } = context.create()
      context.authorize(plan.id)
      const ticket = context.engine.require(mapping.work!)
      if (kind === 'active') context.active.add(ticket.id)
      if (kind === 'job') context.jobs.add(ticket.id)
      if (kind === 'running') latestAssignment(ticket)!.state = 'running'
      if (kind === 'reconciliation') ticket.reconciliation = 'check'
      if (kind === 'agent') context.store.saveEntity('worker_agent', 'agent', { id: 'agent', ticketId: ticket.id, cleanup: 'uncertain' })
      if (kind === 'publish') context.store.saveEffect({ key: 'publish', kind: 'publish', ticketId: ticket.id, generation: 1, payload: {}, state: 'uncertain', attempts: 1, dueAt: 0 })
      if (kind === 'result') ticket.result = { id: randomUUID(), ticketId: ticket.id, kind: 'artifact', content: 'accepted', hash: 'hash', acceptedAt: new Date().toISOString(), operatorId: 'human' }
      if (kind === 'mr') ticket.mergeRequest = { iid: 1, url: 'https://gitlab.com/fixture/project/-/merge_requests/1', headSha: context.mainSha, branch: 'test', state: 'open' }
      context.store.save(ticket)
      await assert.rejects(context.configure(await context.preview(plan.id)), error => error instanceof DomainError && ['WORKSPACE_BUSY', 'INVALID_STATE'].includes(error.code))
      assert.equal(context.store.entities('workspace_archive').length, 0)
    } finally { await context.close() }
  })
}

test('pinned plans do not drift when refs advance and reject absent code dependencies before claiming', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create({ dependencies: [{ before: 'work', after: 'integration', condition: 'code' }] })
    await context.configure(await context.preview(plan.id))
    await git(context.repo, ['update-ref', 'refs/remotes/origin/main', context.v1Sha])
    await context.controller.validatePlan(context.store.entity<Plan>('plan', plan.id)!)
    context.authorize(plan.id)
    assert.equal((await context.prepare(mapping.work!)).ready, true)
    assert.equal(context.engine.require(mapping.work!).baseSha, context.mainSha)
    const upstream = context.engine.require(mapping.work!)
    upstream.result = { id: randomUUID(), ticketId: upstream.id, kind: 'code', content: 'merged', hash: 'hash', sha: context.v1Sha, acceptedAt: new Date().toISOString(), operatorId: 'human' }
    context.store.save(upstream)
    const failed = await context.prepare(mapping.integration!)
    assert.equal(failed.code, 'WORKSPACE_DEPENDENCY_MISSING')
    assert.equal(latestAssignment(context.engine.require(mapping.integration!))!.startedAt, undefined)
  } finally { await context.close() }
})

test('workspace paths and bound Git ownership cannot be replaced by symlinks or a foreign repository', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.configure(await context.preview(plan.id))
    context.authorize(plan.id)
    const ticket = context.engine.require(mapping.work!)
    const path = join(context.repository.executionRoot, `${ticket.id}-${ticket.workspaceBinding!.id}`)
    await symlink(context.repo, path)
    assert.equal((await context.prepare(ticket.id)).ready, false)
    assert.equal(await git(context.repo, ['status', '--porcelain']), '')
    await rm(path)
    assert.equal((await context.prepare(ticket.id)).ready, true)
    const bound = context.engine.require(ticket.id)
    bound.workspaceBinding!.repositoryId = 'foreign'
    await assert.rejects(prepareWorkspace(context.repository, bound), /当前已登记仓库/)
    bound.workspaceBinding!.repositoryId = context.repository.id
    bound.baseSha = context.v1Sha
    await assert.rejects(prepareWorkspace(context.repository, bound), /不符合计划绑定/)
  } finally { await context.close() }
})

test('GitLab observation and accepted code use the bound target instead of global HEAD', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.configure(await context.preview(plan.id, 'refs/remotes/origin/insight-v1'))
    context.authorize(plan.id)
    await context.prepare(mapping.work!)
    const ticket = context.engine.require(mapping.work!)
    ticket.mergeRequest = { iid: 1, url: 'https://gitlab.com/fixture/project/-/merge_requests/1', headSha: context.v1Sha, branch: ticket.branch!, state: 'open' }
    context.store.save(ticket)
    const api = { read: async () => ({ iid: 1, project_id: 1, source_project_id: 1, target_project_id: 1, source_branch: ticket.branch, target_branch: 'insight-v1', sha: context.v1Sha, state: 'merged', merge_commit_sha: context.v1Sha, web_url: ticket.mergeRequest!.url }), feedback: async () => [] } as unknown as GitLabPort
    const delivery = new Delivery(context.store, context.engine, context.root, api, async () => {})
    await delivery.observe(ticket.id)
    assert.equal(context.engine.require(ticket.id).mergeRequest!.state, 'merged')
    assert.equal(await verifyAcceptedCode(context.repository, context.engine.require(ticket.id)), context.v1Sha)
    assert.equal(await git(context.repo, ['rev-parse', 'HEAD']), context.mainSha)
  } finally { await context.close() }
})

test('workspace selection in new plans is strict and mismatched per-task binding is blocked', async () => {
  const context = await fixture()
  try {
    const input = { repositoryId: context.repository.id, baseRef: 'refs/heads/main', baseSha: context.mainSha, branchPrefix: 'superagent' }
    await context.controller.validateInput(input)
    const { plan, mapping } = context.create({ workspace: input })
    assert.equal(plan.workspace!.baseSha, context.mainSha)
    assert.deepEqual(context.engine.require(mapping.work!).workspaceBinding, plan.workspace)
    assert.throws(() => context.create({ workspace: { ...input, repositoryId: 'foreign' } }))
    await assert.rejects(context.controller.validateInput({ ...input, baseSha: context.v1Sha }), /SHA 不匹配/)
    const ticket = context.engine.require(mapping.work!)
    ticket.workspaceBinding = workspaceBinding(input, randomUUID())
    context.store.save(ticket)
    await assert.rejects(context.controller.validatePlan(plan), /绑定不一致/)
    assert.throws(() => context.engine.call('task_workspace_prepare', { ticketId: ticket.id, expectedRevision: ticket.revision }), /project workspace service/)
  } finally { await context.close() }
})

test('concurrent prepares share one operation and migration cannot race an in-flight preparation', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.configure(await context.preview(plan.id))
    context.authorize(plan.id)
    const preview = await context.preview(plan.id, 'refs/remotes/origin/insight-v1')
    const validate = context.controller.validatePlan.bind(context.controller)
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    context.controller.validatePlan = async current => { await barrier; await validate(current) }
    const params = { ticketId: mapping.work!, expectedRevision: context.engine.require(mapping.work!).revision }
    const first = context.controller.prepare(params)
    assert.equal(context.controller.prepare(params), first)
    await assert.rejects(context.configure(preview), /运行或准备工作区/)
    release()
    assert.equal((await first as any).ready, true)
    const trees = await git(context.repo, ['worktree', 'list', '--porcelain'])
    assert.equal((trees.match(/^worktree /gm) ?? []).length, 2)
  } finally { await context.close() }
})

test('in-flight worktree preparation reserves worker capacity and conflicting resources before claim', async () => {
  const context = await fixture()
  try {
    const tasks = ['first', 'second', 'third', 'integration'].map(key => ({ key, title: key, request: `Implement ${key}`, resources: key === 'first' || key === 'second' ? ['shared'] : [] }))
    const dependencies = ['first', 'second', 'third'].map(before => ({ before, after: 'integration', condition: 'artifact' }))
    const { plan, mapping } = context.create({ tasks, dependencies })
    context.authorize(plan.id)
    const busy = new Set([mapping.first!])
    assert.equal(candidates(context.store, new Set(), busy, 1).length, 0)
    const available = candidates(context.store, new Set(), busy, 2)
    assert.deepEqual(available.map(effect => effect.ticketId), [mapping.third])
    assert.equal(context.store.effects().every(effect => effect.attempts === 0 && effect.state === 'pending'), true)
  } finally { await context.close() }
})

for (const change of ['stop', 'delete']) {
  test(`preflight cannot resurrect or authorize a task changed during async preparation: ${change}`, async () => {
    const context = await fixture()
    try {
      const { plan, mapping } = context.create()
      await context.configure(await context.preview(plan.id))
      context.authorize(plan.id)
      let release!: () => void
      const barrier = new Promise<void>(resolve => { release = resolve })
      const validate = context.controller.validatePlan.bind(context.controller)
      context.controller.validatePlan = async current => { await barrier; await validate(current) }
      const pending = context.prepare(mapping.work!)
      const rejection = assert.rejects(pending)
      const current = context.engine.require(mapping.work!)
      context.engine.call('task_stop', { ticketId: current.id, expectedRevision: current.revision, requestId: randomUUID(), reason: 'test human stop' })
      if (change === 'delete') {
        const before = context.store.entity<Plan>('plan', plan.id)!
        context.engine.call('plan_stop', { planId: plan.id, expectedRevision: before.revision, requestId: randomUUID(), reason: 'stop before deletion' })
        const changed = context.store.entity<Plan>('plan', plan.id)!
        deleteRecords(context.engine, 'delete-plan', { planId: plan.id, expectedRevision: changed.revision, tasks: changed.ticketIds.map(id => ({ ticketId: id, expectedRevision: context.engine.require(id).revision })), requestId: randomUUID() }, new Set(), new Set())
      }
      release()
      await rejection
      if (change === 'delete') assert.equal(context.store.ticket(current.id), undefined)
      else {
        assert.equal(context.engine.require(current.id).mandate.humanHold, true)
        assert.notEqual(latestAssignment(context.engine.require(current.id))?.state, 'running')
      }
      assert.equal(context.store.get(`workspace:blocker:${current.id}`), null)
    } finally { await context.close() }
  })
}

test('daemon prepares before claim, bridge cannot migrate, and repaired workspace dispatches without a paid failure', async () => {
  const context = await fixture()
  let service: Awaited<ReturnType<typeof startService>> | undefined
  try {
    await mkdir(join(context.repo, '.codex'))
    await writeFile(join(context.repo, '.codex', 'config.toml'), 'fixture = true\n')
    await git(context.repo, ['add', '.'])
    await git(context.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'configuration'])
    const baseSha = await git(context.repo, ['rev-parse', 'HEAD'])
    const state = join(context.root, 's')
    await initialize(state, context.repo, join(context.root, 'worker'), 'test-model', 'main')
    const launches: Ticket[] = []
    const active = new Map<string, Ticket>()
    service = await startService(state, (_store, engine) => ({ active, async launch(ticket) { launches.push(ticket); active.set(ticket.id, ticket) }, async stop(id) { active.delete(id); engine.stopped(id) }, async decideRuntime() {}, async shutdown() { active.clear() } }))
    const repositoryId = service.store.repository()!.id
    const request = { repositoryId, title: 'Dispatch test', tasks: [{ key: 'work', title: 'Work', request: 'Work in prepared cwd' }], dependencies: [], integrationKey: 'work', expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID(), workspace: { repositoryId, baseRef: 'refs/heads/main', baseSha, branchPrefix: 'superagent' } }
    const invalid = await invoke(state, 'bridge', 'plan_create', { ...request, workspace: { ...request.workspace, baseSha: context.v1Sha } })
    assert.equal(invalid.error?.code, 'WORKSPACE_REF_MOVED')
    const created = await invoke(state, 'bridge', 'plan_create', request)
    assert.equal(created.ok, true)
    await git(context.repo, ['update-ref', 'refs/heads/main', context.mainSha])
    assert.deepEqual((await invoke(state, 'bridge', 'plan_create', request)).data, created.data)
    assert.equal((await invoke(state, 'bridge', 'plan_create', { ...request, title: 'Changed' })).error?.code, 'IDEMPOTENCY_CONFLICT')
    await git(context.repo, ['update-ref', 'refs/heads/main', baseSha])
    const { plan, mapping } = created.data as { plan: Plan; mapping: Record<string, string> }
    const preview = await invoke(state, 'bridge', 'plan_workspace_preview', { planId: plan.id, expectedRevision: plan.revision, repositoryId, baseRef: 'refs/heads/main', branchPrefix: 'superagent' })
    assert.equal(preview.ok, true)
    const denied = await invoke(state, 'bridge', 'plan-workspace-configure', { planId: plan.id, expectedRevision: plan.revision, previewId: (preview.data as any).id, requestId: randomUUID(), confirmation: plan.id })
    assert.equal(denied.error?.code, 'FORBIDDEN')
    const unapproved = await invoke(state, 'bridge', 'task_workspace_prepare', { ticketId: mapping.work, expectedRevision: service.engine.require(mapping.work!).revision })
    assert.equal(unapproved.error?.code, 'WORKSPACE_NOT_READY')
    service.engine.call('plan_start', { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() })
    const approval = service.store.approvals(plan.id).find(entry => entry.status === 'pending')!
    service.engine.approve(approval.id, true, String(approval.details.fingerprint))
    for (let attempt = 0; attempt < 100 && service.engine.view(service.engine.require(mapping.work!)).scheduling.state !== 'waiting_workspace'; attempt++) await delay(30)
    const ticket = service.engine.require(mapping.work!)
    assert.equal(service.engine.view(ticket).scheduling.state, 'waiting_workspace')
    assert.equal(launches.length, 0)
    assert.equal(latestAssignment(ticket)!.startedAt, undefined)
    assert.equal(service.store.effects()[0]!.attempts, 0)
    await delay(250)
    assert.equal(service.store.events(ticket.id).filter(entry => entry.event === 'workspace.blocked').length, 1)
    await rm(join(ticket.workspace!, '.codex'), { recursive: true })
    const rechecked = await invoke(state, 'bridge', 'task_workspace_prepare', { ticketId: ticket.id, expectedRevision: ticket.revision })
    assert.equal(rechecked.ok, true)
    assert.equal((rechecked.data as any).ready, true)
    for (let attempt = 0; attempt < 100 && !launches.length; attempt++) await delay(30)
    assert.equal(launches.length, 1)
    assert.equal(launches[0]!.workspace, ticket.workspace)
    assert.equal(service.store.effects()[0]!.attempts, 1)
  } finally { await service?.close(); await context.close() }
})
