import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Engine } from '../core/src/engine.js'
import { latestAssignment, type Plan, type Ticket } from '../core/src/model.js'
import { candidates } from '../core/src/scheduler.js'
import { Store } from '../storage/src/store.js'
import { TaskMaterials, executionMaterials } from '../service/src/materials.js'
import { WorkflowController } from '../service/src/workflow.js'
import type { RuntimeController } from '../service/src/runtime.js'

async function fixture(paths: string[] = []) {
  const parent = resolve('../.cache')
  await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'workflow-')))
  const state = join(root, 'state')
  await mkdir(state)
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo', path: join(root, 'repo'), executionRoot: join(root, 'worktrees') })
  const engine = new Engine(store, 'human')
  const materials = new TaskMaterials(state, store, engine, () => new Map())
  const workflow = new WorkflowController(store, engine, materials)
  const create = (options: Record<string, unknown> = {}) => engine.call('plan_create', {
    repositoryId: 'repo', title: 'A single goal',
    tasks: [{ key: 'research', title: 'Research', request: 'Read the supplied references' }, { key: 'integration', title: 'Integrate', request: 'Deliver the summary' }],
    dependencies: [{ before: 'research', after: 'integration', condition: 'artifact' }], integrationKey: 'integration',
    maxAttempts: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString(), workflow: { automaticHandoffs: true, materialPaths: paths }, requestId: randomUUID(), ...options,
  }) as { plan: Plan; mapping: Record<string, string> }
  const authorize = async (plan: Plan) => workflow.control({ action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() } })
  const ready = (ticketId: string) => {
    const effect = store.effects('pending').find(entry => entry.ticketId === ticketId)!
    const ticket = engine.claim(effect)!
    assert.ok(ticket)
    const assignment = latestAssignment(ticket)!
    engine.updateExecution(ticketId, assignment.id, current => { for (const input of current.inputs) input.state = 'accepted' }, 'test.inputs')
    engine.report(ticketId, assignment.id, { state: 'ready', summary: 'Reviewable result', checks: ['Read all declared sections'], question: null })
    store.saveEffect({ ...store.effects().find(entry => entry.key === effect.key)!, state: 'done' })
  }
  return { root, state, store, engine, materials, workflow, create, authorize, ready, async close() { store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('goal confirmation authorizes the DAG once; artifact handoff unlocks integration without manual acceptance', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    const request = { action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() } }
    const [first, second] = await Promise.all([context.workflow.control(request), context.workflow.control(request)])
    assert.deepEqual(first, second)
    assert.deepEqual(await context.workflow.control(request), first)
    assert.equal(context.engine.require(mapping.research!).assignments.length, 1)
    assert.equal(context.engine.view(context.engine.require(mapping.integration!)).scheduling.state, 'waiting_dependencies')
    context.ready(mapping.research!)
    assert.equal(context.engine.coordination.advanceHandoffs(), 1)
    assert.equal(context.engine.require(mapping.research!).result?.acceptedBy, 'coordinator')
    assert.equal(context.engine.require(mapping.research!).result?.operatorId, 'coordinator')
    assert.equal(context.engine.view(context.engine.require(mapping.integration!)).scheduling.state, 'ready')
    context.ready(mapping.integration!)
    assert.equal(context.engine.coordination.advanceHandoffs(), 0)
    assert.equal(context.engine.require(mapping.integration!).result, undefined)
    assert.equal(context.engine.coordination.advanceHandoffs(), 0)
    await assert.rejects(async () => context.workflow.control({ ...request, params: { ...request.params, expectedRevision: 99 } }), /reused/)
  } finally { await context.close() }
})

test('automatic handoffs exclude milestones, code edges, old plans, paused plans and pending work', async () => {
  for (const scenario of ['milestone', 'code', 'legacy', 'paused', 'globalPause', 'hold', 'expired', 'question', 'emptyChecks', 'input', 'effect', 'approval', 'changedScope', 'failed', 'uncertain']) {
    const context = await fixture()
    try {
      const { plan, mapping } = context.create(scenario === 'code' ? { dependencies: [{ before: 'research', after: 'integration', condition: 'code' }] } : scenario === 'milestone' ? { tasks: [{ key: 'research', title: 'Milestone', request: 'Explicit review', reviewRequired: true }, { key: 'integration', title: 'Integrate', request: 'Combine' }] } : {})
      if (scenario === 'legacy') { delete plan.workflow; context.store.saveEntity('plan', plan.id, plan) }
      await context.authorize(plan)
      context.ready(mapping.research!)
      const current = context.store.entity<Plan>('plan', plan.id)!
      const ticket = context.engine.require(mapping.research!)
      if (scenario === 'paused') current.paused = true
      if (scenario === 'globalPause') context.store.set('paused', true)
      if (scenario === 'hold') ticket.mandate.humanHold = true
      if (scenario === 'expired') current.expiresAt = new Date(Date.now() - 1).toISOString()
      if (scenario === 'question') ticket.report!.question = 'Confirm the approach'
      if (scenario === 'emptyChecks') ticket.report!.checks = []
      if (scenario === 'input') ticket.inputs[0]!.state = 'pending'
      if (scenario === 'effect') context.store.saveEffect({ ...context.store.effects()[0]!, state: 'uncertain' })
      if (scenario === 'approval') context.store.saveApproval({ ...context.store.approvals()[0]!, id: randomUUID(), ticketId: ticket.id, status: 'pending' })
      if (scenario === 'changedScope') ticket.scope = 'Changed outside the approved fingerprint'
      if (scenario === 'failed') ticket.failure = 'failed'
      if (scenario === 'uncertain') ticket.reconciliation = 'inspect first'
      context.store.save(ticket); context.store.saveEntity('plan', plan.id, current)
      assert.equal(context.engine.coordination.advanceHandoffs(), 0, scenario)
      assert.equal(context.engine.require(ticket.id).result, undefined, scenario)
    } finally { await context.close() }
  }
})

test('one goal approval shares immutable read-only snapshots with every member and reuses them on resume', async () => {
  const context = await fixture()
  try {
    const source = join(context.root, 'spec.pdf')
    await writeFile(source, 'User-provided specification')
    const { plan } = context.create({ workflow: { materialPaths: [source] } })
    await context.authorize(plan)
    const first = await executionMaterials(context.state, context.store, plan.ticketIds[0]!)
    const second = await executionMaterials(context.state, context.store, plan.ticketIds[1]!)
    assert.deepEqual(first.files, second.files)
    assert.equal(first.files.length, 1)
    assert.notEqual(first.files[0]!.path, source)
    await writeFile(source, 'Changed source after approval')
    assert.equal(await readFile(first.files[0]!.path, 'utf8'), 'User-provided specification')
    context.engine.call('plan_stop', { planId: plan.id, expectedRevision: context.store.entity<Plan>('plan', plan.id)!.revision, reason: 'Pause the goal', requestId: randomUUID() })
    await context.authorize(context.store.entity<Plan>('plan', plan.id)!)
    assert.deepEqual((await executionMaterials(context.state, context.store, plan.ticketIds[0]!)).files, first.files)
    const unrelated = (context.engine.call('task_create', { repositoryId: 'repo', title: 'Unrelated', request: 'No access to goal references', requestId: randomUUID() }) as { ticket: Ticket }).ticket
    context.store.saveEntity('task_materials', unrelated.id, first.files)
    await assert.rejects(executionMaterials(context.state, context.store, unrelated.id), /does not belong/)
  } finally { await context.close() }
})

test('protected or missing goal references prevent authorization and snapshot rollback leaves no grant', async () => {
  const context = await fixture()
  try {
    const secret = join(context.state, 'admin.token')
    await writeFile(secret, 'Synthetic test token')
    for (const path of [secret, join(context.root, 'missing.pdf')]) {
      const { plan } = context.create({ workflow: { materialPaths: [path] } })
      await assert.rejects(context.authorize(plan))
      assert.equal(context.store.entity<Plan>('plan', plan.id)!.grant, undefined)
      assert.ok(plan.ticketIds.every(id => context.engine.require(id).assignments.length === 0))
    }
    const source = join(context.root, 'reference.txt')
    await writeFile(source, 'snapshot rollback')
    const { plan } = context.create({ workflow: { materialPaths: [source] } })
    const prepared = await context.materials.preparePlan(plan)
    let snapshot = ''
    assert.throws(() => context.store.atomic(() => {
      prepared.commit()
      snapshot = context.store.entity<{ files: { path: string }[] }>('plan_materials', plan.id)!.files[0]!.path
      throw new Error('Simulate concurrent approval change')
    }), /concurrent/)
    await prepared.discard()
    await assert.rejects(readFile(snapshot), { code: 'ENOENT' })
    assert.equal(context.store.entity('plan_materials', plan.id), undefined)
    assert.equal(context.store.entity('task_materials', plan.ticketIds[0]!), undefined)
  } finally { await context.close() }
})

test('trusted manual retry adds exactly one attempt without a second approval; MCP still requests approval', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.authorize(plan)
    const ticketId = mapping.research!
    const effect = context.store.effects('pending').find(entry => entry.ticketId === ticketId)!
    const ticket = context.engine.claim(effect)!
    context.engine.fail(ticketId, latestAssignment(ticket)!.id, 'Business failure')
    context.store.saveEffect({ ...context.store.effects().find(entry => entry.key === effect.key)!, state: 'done' })
    const request = { action: 'task_retry', params: { ticketId, expectedRevision: context.engine.require(ticketId).revision, requestId: randomUUID() } }
    await context.workflow.control(request)
    await context.workflow.control(request)
    assert.equal(latestAssignment(context.engine.require(ticketId))!.generation, 2)
    assert.equal(context.store.approvals(ticketId).filter(approval => approval.status === 'pending').length, 0)
    assert.equal(context.store.entity<Plan>('plan', plan.id)!.maxAttempts, 1)
    const second = context.store.effects('pending').find(entry => entry.ticketId === ticketId)!
    context.engine.claim(second)
    context.engine.fail(ticketId, second.key, 'Still failed')
    context.store.saveEffect({ ...context.store.effects().find(entry => entry.key === second.key)!, state: 'done' })
    context.engine.call('task_retry', { ticketId, expectedRevision: context.engine.require(ticketId).revision, requestId: randomUUID() })
    assert.equal(latestAssignment(context.engine.require(ticketId))!.generation, 2)
    assert.equal(context.store.approvals(ticketId).filter(approval => approval.status === 'pending').length, 1)
  } finally { await context.close() }
})

test('preparation recovery backs off without a new assignment and stops after three safe cancellations', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    await context.authorize(plan)
    const ticketId = mapping.research!
    for (let attempt = 1; attempt <= 3; attempt++) {
      const effect = { ...context.store.effects('pending').find(entry => entry.ticketId === ticketId)!, dueAt: 0 }
      context.store.saveEffect(effect)
      const ticket = context.engine.claim(effect)!
      assert.equal(context.engine.cancelPreparation(ticketId, latestAssignment(ticket)!.id), true)
      assert.equal(latestAssignment(context.engine.require(ticketId))!.generation, 1)
      if (attempt < 3) assert.equal(candidates(context.store, new Set(), new Set(), 1).filter(entry => entry.ticketId === ticketId).length, 0)
    }
    assert.match(context.engine.require(ticketId).failure!, /three times/)
    assert.equal(context.store.effects('pending').filter(entry => entry.ticketId === ticketId).length, 0)
  } finally { await context.close() }
})

test('failed environment preparation does not grant a goal or copy references', async () => {
  const context = await fixture()
  try {
    const runtime = { check: async () => ({ canDispatch: false, phase: 'auth_required', reasonCodes: ['AUTH_REQUIRED'] }) } as unknown as RuntimeController
    const workflow = new WorkflowController(context.store, context.engine, context.materials, runtime)
    const { plan } = context.create()
    await assert.rejects(workflow.control({ action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() } }), { code: 'AUTH_REQUIRED' })
    assert.equal(context.store.entity<Plan>('plan', plan.id)!.grant, undefined)
    assert.equal(context.store.effects().length, 0)
  } finally { await context.close() }
})

test('reference aliases and symlinks into protected state cannot acquire goal access', async () => {
  const context = await fixture()
  try {
    const source = join(context.root, 'public.txt'), alias = join(context.root, 'alias.txt')
    await writeFile(source, 'public reference'); await symlink(source, alias)
    const duplicate = context.create({ workflow: { materialPaths: [source, alias] } }).plan
    await assert.rejects(context.authorize(duplicate), /Duplicate resolved/)
    const secret = join(context.state, 'admin.token'), link = join(context.root, 'reference.txt')
    await writeFile(secret, 'synthetic secret'); await symlink(secret, link)
    const protectedPlan = context.create({ workflow: { materialPaths: [link] } }).plan
    await assert.rejects(context.authorize(protectedPlan), { code: 'FORBIDDEN' })
    assert.ok(context.store.tickets().every(ticket => !ticket.mandate.executionGranted))
  } finally { await context.close() }
})

test('goal confirmation preserves independent holds and leaves already running assignments untouched', async () => {
  const context = await fixture()
  try {
    const { plan, mapping } = context.create()
    context.engine.call('task_stop', { ticketId: mapping.integration, expectedRevision: context.engine.require(mapping.integration!).revision, reason: 'Independent human hold', requestId: randomUUID() })
    await context.authorize(plan)
    assert.equal(context.engine.require(mapping.integration!).mandate.humanHold, true)
    const effect = context.store.effects('pending').find(entry => entry.ticketId === mapping.research)!
    const running = context.engine.claim(effect)!
    await context.authorize(context.store.entity<Plan>('plan', plan.id)!)
    assert.equal(context.engine.require(mapping.research!).assignments.length, 1)
    assert.equal(latestAssignment(context.engine.require(mapping.research!))!.id, latestAssignment(running)!.id)
    assert.equal(latestAssignment(context.engine.require(mapping.research!))!.state, 'running')
    assert.equal(context.engine.require(mapping.integration!).mandate.humanHold, true)
  } finally { await context.close() }
})

test('a goal changed during preflight leaves no material distribution, runtime enablement or task grant', async () => {
  const context = await fixture()
  try {
    const source = join(context.root, 'spec.txt')
    await writeFile(source, 'Goal-specific reference')
    const { plan, mapping } = context.create({ workflow: { materialPaths: [source] } })
    const runtime = {
      check: async () => {
        const ticket = context.engine.require(mapping.research!)
        ticket.scope = 'Concurrent scope change'
        context.store.save(ticket)
        return { canDispatch: false, phase: 'ready', revision: 1, fingerprint: 'a'.repeat(64), reasonCodes: ['RUNTIME_ENABLEMENT_REQUIRED'] }
      },
      enableForWorkflow: () => context.store.set('test:runtime-enabled', true),
    } as unknown as RuntimeController
    const workflow = new WorkflowController(context.store, context.engine, context.materials, runtime)
    await assert.rejects(workflow.control({ action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() } }), /Displayed plan changed/)
    assert.equal(context.store.get('test:runtime-enabled'), undefined)
    assert.equal(context.store.entity('plan_materials', plan.id), undefined)
    assert.equal(context.store.entity('task_materials', mapping.research!), undefined)
    assert.equal(context.store.entity<Plan>('plan', plan.id)!.grant, undefined)
  } finally { await context.close() }
})
