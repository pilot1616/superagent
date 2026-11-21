import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import { latestAssignment, type Ticket } from '../core/src/model.js'
import { configSchema, initialize, migrateConfig, readConfig, acquireLock } from '../service/src/config.js'
import { RuntimeController } from '../service/src/runtime.js'
import { WorkflowController } from '../service/src/workflow.js'
import { TaskMaterials } from '../service/src/materials.js'
import { RuntimeVerificationService } from '../service/src/runtime-verification.js'
import { createProfile, loadProfile, canonicalJson, providerSchema } from '../executor-codex/src/profile.js'
import { evaluateRuntime, executionVerified } from '../executor-codex/src/acceptance.js'
import { inspectionSchema, requiredCapabilities } from '../executor-codex/src/contracts.js'
import { newVerification } from '../executor-codex/src/verification.js'
import { sha256 } from '../executor-codex/src/inspection.js'
import { decodeRequest, declineResponse, inputResponse } from '../executor-codex/src/approvals.js'
import { git } from '../service/src/workspace.js'
import { checkWorker } from '../executor-codex/src/probe.js'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/sa-runtime-'))
  const store = new Store(join(root, 'tasks.sqlite'))
  store.set('repository', { id: 'fixture', path: '/fixture', executionRoot: '/fixture-worktrees', baseRef: 'main', baseSha: 'a'.repeat(40), remote: '' })
  const profile = await createProfile(root, 'fixture-model')
  const config = configSchema.parse({ version: 3, operatorId: 'human', concurrency: 2, runtime: {} })
  let inspections = 0
  let authenticated = true
  const inspect: NonNullable<ConstructorParameters<typeof RuntimeController>[3]> = async (_state, repositoryId, generation, ttlSeconds) => {
    inspections++
    const currentProfile = await loadProfile(root)
    const now = Date.now()
    return inspectionSchema.parse({ id: randomUUID(), repositoryId, checkedAt: new Date(now).toISOString(), validUntil: new Date(now + ttlSeconds * 1000).toISOString(), fingerprint: sha256(canonicalJson({ profile: currentProfile.hash, generation, fixture: true })), executable: { realpath: process.execPath, version: 'fixture', sha256: sha256('fixture-binary') }, platform: { os: process.platform, release: 'fixture', arch: process.arch }, runtimeBuildHash: sha256('fixture-build'), protocolSchemaHash: sha256('fixture-protocol'), profileHash: currentProfile.hash, policyHash: sha256('fixture-policy'), model: currentProfile.model, provider: { id: 'openai', authMode: 'openai' }, auth: { status: authenticated ? 'configured' : 'missing', generation }, checks: [{ key: 'auth', status: authenticated ? 'passed' : 'failed', reasonCode: authenticated ? undefined : 'AUTH_REQUIRED' }] })
  }
  const runtime = new RuntimeController(store, root, config, inspect)
  const engine = new Engine(store, 'human', undefined, runtime)
  function task(approved = true) {
    const { ticket } = engine.call('task_create', { repositoryId: 'fixture', title: 'Synthetic gate regression', request: 'No real model or real evidence', requestId: randomUUID() }) as { ticket: Ticket }
    if (approved) { engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() }); engine.approve(store.approvals(ticket.id)[0]!.id, true) }
    return engine.require(ticket.id)
  }
  async function verified() {
    await runtime.check()
    const verification = newVerification('fixture', runtime.snapshot().inspection!.fingerprint)
    runtime.beginVerification(verification)
    const evidenceId = randomUUID(), relativePath = `${evidenceId}.json`
    const contents = JSON.stringify({ testOnly: true, notRealWorkerEvidence: true })
    await mkdir(join(root, 'runtime/evidence', verification.id), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'runtime/evidence', verification.id, relativePath), contents, { mode: 0o600 })
    Object.assign(verification, { state: 'passed', finishedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 3600_000).toISOString(), evidence: [{ id: evidenceId, relativePath, sha256: sha256(contents), source: 'harness' }], capabilities: Object.fromEntries(requiredCapabilities.map(key => [key, { status: 'passed', evidenceIds: [evidenceId] }])) })
    runtime.finishVerification(verification)
    return verification
  }
  function enable() {
    const preview = runtime.preview('enable', { expectedRevision: runtime.state().revision, repositoryId: 'fixture' })
    const params = { requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId: 'fixture', confirmation: 'fixture', reviewId: preview.reviewId, mode: 'restricted_local', verificationId: preview.verificationId, expectedFingerprint: preview.expectedFingerprint, reason: 'Synthetic regression only, not runtime acceptance' }
    return { params, result: runtime.enable(params) }
  }
  return { root, profile, store, config, runtime, engine, task, verified, enable, restart: () => new RuntimeController(store, root, config, inspect), inspections: () => inspections, setAuthenticated: (value: boolean) => { authenticated = value }, async close() { store.close(); await rm(root, { recursive: true, force: true }) } }
}

test('goal runtime authorization survives a clean restart only after a matching fresh inspection', async () => {
  const context = await fixture()
  try {
    await context.runtime.check()
    context.enable()
    const original = context.runtime.snapshot().enablement!
    const previousFence = context.runtime.state().fence
    const restarted = context.restart()
    assert.equal(restarted.status().canDispatch, false)
    assert.ok(restarted.state().fence > previousFence)
    await restarted.check()
    assert.equal(restarted.status().canDispatch, true)
    assert.equal(restarted.snapshot().enablement!.id, original.id)
    assert.equal(restarted.snapshot().enablement!.expiresAt, original.expiresAt)
    assert.notEqual(restarted.snapshot().enablement!.daemonEpoch, original.daemonEpoch)
  } finally { await context.close() }
})

test('one trusted goal confirmation inspects and enables the runtime and authorizes its DAG atomically', async () => {
  const context = await fixture()
  try {
    const materials = new TaskMaterials(context.root, context.store, context.engine, () => new Map())
    const workflow = new WorkflowController(context.store, context.engine, materials, context.runtime)
    const { plan } = context.engine.call('plan_create', { repositoryId: 'fixture', title: 'Unified confirmation', tasks: [{ key: 'final', title: 'Final output', request: 'Synthetic only' }], dependencies: [], integrationKey: 'final', expiresAt: new Date(Date.now() + 3600_000).toISOString(), requestId: randomUUID() }) as { plan: import('../core/src/model.js').Plan }
    assert.equal(context.runtime.status().canDispatch, false)
    const input = { action: 'plan_start', params: { planId: plan.id, expectedRevision: plan.revision, requestId: randomUUID() } }
    await workflow.control(input)
    assert.equal(context.runtime.status().canDispatch, true)
    const enablement = context.runtime.snapshot().enablement!
    assert.match(enablement.reason, /goal/)
    assert.equal(context.engine.decision(context.engine.require(plan.integrationId)).state, 'ready')
    await workflow.control(input)
    assert.equal(context.runtime.snapshot().enablement!.id, enablement.id)
    assert.equal(context.engine.require(plan.integrationId).assignments.length, 1)
  } finally { await context.close() }
})

test('settled pre-turn failures suspend dispatch until reinspection without extending human authorization', async () => {
  const context = await fixture()
  try {
    await context.runtime.check(); context.enable()
    const original = context.runtime.snapshot().enablement!
    context.runtime.recheck()
    assert.equal(context.runtime.status().canDispatch, false)
    await context.runtime.check()
    assert.equal(context.runtime.status().canDispatch, true)
    assert.equal(context.runtime.snapshot().enablement!.id, original.id)
    assert.equal(context.runtime.snapshot().enablement!.expiresAt, original.expiresAt)
    context.setAuthenticated(false)
    context.runtime.recheck(); await context.runtime.check()
    assert.equal(context.runtime.status().canDispatch, false)
  } finally { await context.close() }
})

test('restart never restores expired, disabled, mismatched, quarantined or uncertain runtime authorization', async () => {
  for (const scenario of ['expired', 'disabled', 'mismatched', 'quarantined', 'uncertain', 'unauthenticated']) {
    const context = await fixture()
    try {
      await context.runtime.check(); context.enable()
      const original = context.runtime.snapshot().enablement!
      if (scenario === 'expired') context.store.saveEntity('runtime_enablement', original.id, { ...original, expiresAt: new Date(Date.now() - 1).toISOString() })
      if (scenario === 'disabled') context.runtime.disable({ requestId: randomUUID(), expectedRevision: context.runtime.state().revision, repositoryId: 'fixture', confirmation: 'fixture', mode: 'drain', reason: 'Human disabled execution' })
      if (scenario === 'mismatched') context.store.saveEntity('runtime_enablement', original.id, { ...original, fingerprint: '0'.repeat(64) })
      if (scenario === 'quarantined') context.runtime.quarantine('TEST_UNCERTAINTY', [])
      if (scenario === 'uncertain') { const ticket = context.task(); ticket.reconciliation = 'Inspect previous execution'; context.store.save(ticket) }
      if (scenario === 'unauthenticated') context.setAuthenticated(false)
      const restarted = context.restart()
      await restarted.check()
      assert.equal(restarted.status().canDispatch, false, scenario)
    } finally { await context.close() }
  }
})

test('T01/T03: approved work remains pending without environment inspection or authorization', async () => {
  const context = await fixture()
  try {
    const ticket = context.task()
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(context.engine.claim(context.store.effects('pending')[0]!), undefined)
    assert.equal(context.store.effects('pending')[0]!.attempts, 0)
    assert.equal(latestAssignment(context.engine.require(ticket.id))!.state, 'pending')
    assert.equal(context.engine.view(context.engine.require(ticket.id)).scheduling.reasonCodes?.includes('RUNTIME_INSPECTION_STALE'), true)
    context.setAuthenticated(false); await context.runtime.check()
    assert.equal(context.runtime.status().phase, 'auth_required')
    assert.equal(context.runtime.status().canDispatch, false)
    assert.equal(context.engine.require(ticket.id).failure, undefined)
  } finally { await context.close() }
})

test('human enablement and dispatch work without any verification or fabricated capability', async () => {
  const context = await fixture()
  try {
    await context.runtime.check()
    const status = context.runtime.status()
    assert.equal(status.phase, 'ready')
    assert.equal(status.verificationRequired, false)
    assert.equal(status.verificationPassed, false)
    assert.deepEqual(status.reasonCodes, ['RUNTIME_ENABLEMENT_REQUIRED'])
    assert.equal(status.warningCodes.includes('TOKEN_BUDGET_NOT_ENFORCED'), true)
    assert.equal(status.runtimeReadiness.checks.filter(check => check.key.startsWith('verification:')).every(check => !check.blocking && !check.passed), true)
    const { result } = context.enable()
    assert.equal(result.runtime.canDispatch, true)
    assert.equal(result.runtime.verificationPassed, false)
    assert.deepEqual(result.capabilities, [])
    assert.equal(context.runtime.snapshot().enablement!.verificationId, undefined)
    assert.equal(context.store.entities('runtime_verification').length, 0)
    context.task()
    const claimed = context.engine.claim(context.store.effects('pending')[0]!)!
    assert.ok(claimed)
    const permit = context.runtime.permit(claimed)
    assert.doesNotThrow(() => context.runtime.validate(permit))
    const snapshot = context.runtime.snapshot()
    assert.equal(executionVerified(snapshot), false)
    assert.equal(evaluateRuntime({ ...snapshot, enablement: { ...snapshot.enablement!, expiresAt: new Date(0).toISOString() } }).canDispatch, false)
    assert.equal(evaluateRuntime({ ...snapshot, enablement: { ...snapshot.enablement!, repositoryId: 'another-project' } }).canDispatch, false)
    assert.equal(evaluateRuntime({ ...snapshot, state: { ...snapshot.state, quarantine: { reasonCode: 'PROCESS_CLEANUP_UNCERTAIN', since: new Date().toISOString(), assignmentIds: [] } } }).canDispatch, false)
    assert.equal(evaluateRuntime({ ...snapshot, inspection: { ...snapshot.inspection!, checks: [{ key: 'effective_profile', status: 'failed', reasonCode: 'RUNTIME_UNSUPPORTED' }] } }).canDispatch, false)
    assert.equal(evaluateRuntime({ ...snapshot, inspection: { ...snapshot.inspection!, auth: { status: 'missing', generation: 1 } } }).canDispatch, false)
  } finally { await context.close() }
})

test('incomplete, failed or expired verification cannot become a dispatch prerequisite', async () => {
  const context = await fixture()
  try {
    await context.runtime.check()
    const verification = newVerification('fixture', context.runtime.snapshot().inspection!.fingerprint)
    context.runtime.beginVerification(verification)
    assert.equal(context.runtime.status().phase, 'verifying')
    assert.throws(() => context.enable(), /cannot be enabled/)
    verification.state = 'inconclusive'
    verification.reasonCode = 'VERIFICATION_BUDGET_UNSUPPORTED'
    context.runtime.finishVerification(verification)
    assert.equal(context.runtime.status().phase, 'ready')
    context.enable()
    const snapshot = context.runtime.snapshot()
    for (const state of ['inconclusive', 'failed', 'passed'] as const) {
      const evaluated = evaluateRuntime({ ...snapshot, verification: { ...verification, state, validUntil: new Date(0).toISOString() } })
      assert.equal(evaluated.canDispatch, true)
      assert.equal(evaluated.verificationPassed, false)
      assert.equal(evaluated.warningCodes.includes('RUNTIME_VERIFICATION_INCOMPLETE'), true)
    }
    context.task()
    const claimed = context.engine.claim(context.store.effects('pending')[0]!)!
    assert.doesNotThrow(() => context.runtime.permit(claimed))
  } finally { await context.close() }
})

test('a no-verification enable review still rejects stale project state and queue changes', async () => {
  const context = await fixture()
  try {
    await context.runtime.check()
    const preview = context.runtime.preview('enable', { expectedRevision: context.runtime.state().revision, repositoryId: 'fixture' })
    assert.equal(preview.verificationId, undefined)
    assert.equal(preview.verificationRequired, false)
    assert.deepEqual(preview.capabilities, [])
    const params = { requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId: 'fixture', confirmation: 'fixture', reviewId: preview.reviewId, mode: 'restricted_local', expectedFingerprint: preview.expectedFingerprint, reason: 'No verification regression' }
    assert.throws(() => context.runtime.enable({ ...params, confirmation: 'another-project' }), /exact current project/)
    assert.throws(() => context.runtime.enable({ ...params, expectedRevision: preview.expectedRevision + 1 }), /state changed/)
    context.task()
    assert.throws(() => context.runtime.enable(params), /Queued tasks, budgets or affected executions changed/)
    assert.equal(context.runtime.status().canDispatch, false)
  } finally { await context.close() }
})

test('T02/T07: runtime enablement neither authorizes tasks nor clears service pause or human holds', async () => {
  const context = await fixture()
  try {
    await context.runtime.check(); context.enable()
    const draft = context.task(false)
    assert.equal(context.engine.view(draft).scheduling.state, 'waiting_authorization')
    const ticket = context.task()
    context.store.set('paused', true)
    assert.equal(context.engine.view(ticket).scheduling.state, 'paused')
    assert.equal(context.engine.claim(context.store.effects('pending')[0]!), undefined)
    context.store.set('paused', false)
    context.engine.call('task_stop', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID(), reason: 'Independent hold' })
    assert.equal(context.engine.require(ticket.id).mandate.humanHold, true)
    assert.equal(context.runtime.status().canDispatch, true)
    assert.equal(context.engine.view(context.engine.require(ticket.id)).scheduling.state, 'held')
  } finally { await context.close() }
})

test('T04: fingerprint, auth generation, deadlines and daemon epoch independently invalidate execution', async () => {
  const context = await fixture()
  try {
    await context.verified(); context.enable()
    const before = context.runtime.snapshot()
    assert.equal(evaluateRuntime(before).canDispatch, true)
    assert.equal(evaluateRuntime(before, Date.now() + 61_000).canDispatch, false)
    assert.equal(evaluateRuntime({ ...before, daemonEpoch: randomUUID() }).canDispatch, false)
    await writeFile(join(context.profile.home, '.codex/auth.json'), JSON.stringify({ testOnly: true }), { mode: 0o600 })
    await context.runtime.check()
    assert.ok(context.runtime.state().fence > before.state.fence)
    assert.ok(context.runtime.snapshot().inspection!.auth.generation > before.inspection!.auth.generation)
    assert.equal(context.runtime.status().canDispatch, false)
    assert.notEqual(context.runtime.status().fingerprint, before.inspection!.fingerprint)
  } finally { await context.close() }
})

test('T05: inspection is single-flight and same-environment refresh does not stale reviews', async () => {
  const context = await fixture()
  try {
    const first = context.runtime.check(), second = context.runtime.check()
    assert.equal(first, second)
    await Promise.all([first, second])
    assert.equal(context.inspections(), 1)
    const revision = context.runtime.state().revision
    await context.runtime.check()
    assert.equal(context.runtime.state().revision, revision)
    await context.verified()
    const preview = context.runtime.preview('enable', { expectedRevision: context.runtime.state().revision, repositoryId: 'fixture' })
    await context.runtime.check()
    assert.equal(context.runtime.state().revision, preview.expectedRevision)
  } finally { await context.close() }
})

test('stop previews remain available even when environment inspection is unavailable', async () => {
  const context = await fixture()
  try {
    assert.equal(context.runtime.snapshot().inspection, undefined)
    const review = context.runtime.preview('disable', { expectedRevision: context.runtime.state().revision, repositoryId: 'fixture' })
    const result = context.runtime.disable({ requestId: randomUUID(), expectedRevision: review.expectedRevision, repositoryId: 'fixture', confirmation: 'fixture', reviewId: review.reviewId, mode: 'stop', reason: 'Stop remains usable independently of runtime readiness' })
    assert.equal(result.mode, 'stop')
    assert.equal(result.runtime.canDispatch, false)
  } finally { await context.close() }
})

test('T05: enable/disable use CAS, one-use reviews and content-bound idempotency', async () => {
  const context = await fixture()
  try {
    await context.verified()
    const { params, result } = context.enable()
    assert.deepEqual(context.runtime.enable(params), JSON.parse(JSON.stringify(result)))
    assert.throws(() => context.runtime.enable({ ...params, reason: 'Changed request content' }), /different content/)
    assert.throws(() => context.runtime.enable({ ...params, requestId: randomUUID() }), /state changed/)
    const revision = context.runtime.state().revision
    const input = { requestId: randomUUID(), expectedRevision: revision, repositoryId: 'fixture', confirmation: 'fixture', mode: 'drain', reason: 'Pause without expanding anything' }
    const disabled = context.runtime.disable(input)
    assert.deepEqual(context.runtime.disable(input), JSON.parse(JSON.stringify(disabled)))
    assert.equal(context.runtime.status().canDispatch, false)
    assert.throws(() => context.runtime.disable({ ...input, requestId: randomUUID() }), /state changed/)
  } finally { await context.close() }
})

test('T06: disabling after claim fences the permit and rolls back only the pre-turn attempt', async () => {
  const context = await fixture()
  try {
    await context.runtime.check(); context.enable()
    const ticket = context.task()
    const claimed = context.engine.claim(context.store.effects('pending')[0]!)!
    const assignment = latestAssignment(claimed)!
    const permit = context.runtime.permit(claimed)
    assert.equal(assignment.runtimeFingerprint, permit.fingerprint)
    assert.equal(Object.isFrozen(permit), true)
    assert.throws(() => context.runtime.validate({ ...permit }), /permit expired/)
    context.runtime.disable({ requestId: randomUUID(), expectedRevision: context.runtime.state().revision, repositoryId: 'fixture', confirmation: 'fixture', mode: 'drain', reason: 'Stop preparation' })
    assert.throws(() => context.runtime.validate(permit), /permit expired/)
    assert.equal(context.engine.cancelPreparation(ticket.id, assignment.id), true)
    assert.equal(latestAssignment(context.engine.require(ticket.id))!.generation, 1)
    assert.equal(context.store.effects('pending')[0]!.payload.preparationFailures, 1)
    assert.ok(context.store.effects('pending')[0]!.dueAt > Date.now())
    assert.equal(context.engine.require(ticket.id).inputs[0]!.state, 'pending')
    context.enable()
    context.store.saveEffect({ ...context.store.effects('pending')[0]!, dueAt: 0 })
    const restarted = context.engine.claim(context.store.effects('pending')[0]!)!
    context.engine.updateExecution(ticket.id, latestAssignment(restarted)!.id, current => { latestAssignment(current)!.launchPhase = 'turn_sending' }, 'fixture.turn_sending')
    assert.equal(context.engine.cancelPreparation(ticket.id, assignment.id), false)
  } finally { await context.close() }
})

test('damaged optional evidence remains unverified without blocking human enablement', async () => {
  const context = await fixture()
  try {
    const verification = await context.verified()
    await writeFile(join(context.root, 'runtime/evidence', verification.id, verification.evidence[0]!.relativePath), 'tampered synthetic evidence')
    context.enable()
    assert.equal(context.runtime.status().verificationPassed, false)
    assert.equal(context.runtime.status().canDispatch, true)
    assert.deepEqual(context.runtime.snapshot().enablement!.capabilities, [])
    context.task()
    const claimed = context.engine.claim(context.store.effects('pending')[0]!)!
    assert.doesNotThrow(() => context.runtime.validate(context.runtime.permit(claimed)))
  } finally { await context.close() }
})

test('enable review binds the dispatch queue and cannot silently include newly authorized tasks', async () => {
  const context = await fixture()
  try {
    await context.verified()
    const preview = context.runtime.preview('enable', { expectedRevision: context.runtime.state().revision, repositoryId: 'fixture' })
    assert.equal(preview.queued.length, 0)
    context.task()
    assert.throws(() => context.runtime.enable({ requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId: 'fixture', confirmation: 'fixture', reviewId: preview.reviewId, mode: 'restricted_local', verificationId: preview.verificationId, expectedFingerprint: preview.expectedFingerprint, reason: 'Review snapshot only' }), /Queued tasks, budgets or affected executions changed/)
    assert.equal(context.runtime.status().canDispatch, false)
  } finally { await context.close() }
})

test('quarantine blocks execution and human reconciliation discards old verification and enablement', async () => {
  const context = await fixture()
  try {
    await context.verified(); context.enable()
    context.runtime.quarantine('PROCESS_CLEANUP_UNCERTAIN', ['synthetic-assignment'])
    assert.equal(context.runtime.status().phase, 'quarantined')
    const result = await context.runtime.reconcile({ requestId: randomUUID(), expectedRevision: context.runtime.state().revision, repositoryId: 'fixture', confirmation: 'fixture', reason: 'Human inspected the synthetic process fixture and its state' })
    assert.equal(result.canDispatch, false)
    assert.equal(result.verification, undefined)
    assert.equal(context.runtime.state().quarantine, undefined)
  } finally { await context.close() }
})

test('verification preview declares budget limitations; auth and running tasks cannot be bypassed', async () => {
  const context = await fixture()
  try {
    context.setAuthenticated(false); await context.runtime.check()
    const service = new RuntimeVerificationService(context.runtime)
    const preview = service.preview({ expectedRevision: context.runtime.state().revision, repositoryId: 'fixture' })
    assert.equal((preview.detail as { tokenBudgetSupported: boolean }).tokenBudgetSupported, false)
    assert.throws(() => service.start({ requestId: randomUUID(), reviewId: preview.reviewId, expectedRevision: preview.expectedRevision, expectedFingerprint: preview.expectedFingerprint, repositoryId: 'fixture', confirmation: 'fixture', limits: (preview.detail as { limits: unknown }).limits }), /independent Worker model authentication/)
    assert.equal(context.store.entities('runtime_verification').length, 0)
    assert.equal(context.runtime.status().canDispatch, false)
  } finally { await context.close() }
})

test('T08/T09: protocol decoding declines permissions and answers only the current complete question set', () => {
  assert.deepEqual(declineResponse('item/commandExecution/requestApproval'), { decision: 'decline' })
  assert.deepEqual(declineResponse('item/fileChange/requestApproval'), { decision: 'decline' })
  assert.deepEqual(declineResponse('item/permissions/requestApproval'), { permissions: {}, scope: 'turn' })
  assert.throws(() => decodeRequest('future/approval', {}), /Unsupported/)
  assert.throws(() => decodeRequest('item/tool/requestUserInput', { threadId: 't', turnId: 'u', itemId: 'i', questions: [], unknown: true }))
  const questions = [{ id: 'question', header: 'Decision', question: 'Which fixture?', isOther: true, isSecret: false, options: null }]
  assert.deepEqual(inputResponse(questions, { question: { answers: ['Fixture A'] } }), { answers: { question: { answers: ['Fixture A'] } } })
  assert.throws(() => inputResponse(questions, {}), /every current question/)
  assert.throws(() => inputResponse([{ ...questions[0]!, isSecret: true }], { question: { answers: ['not-a-real-secret'] } }), /Secret answers/)
})

test('provider contracts reject implicit identity, credential URLs and unsupported OAuth helpers', () => {
  assert.equal(providerSchema.safeParse({ id: 'other', authMode: 'openai', baseUrl: 'https://example.invalid' }).success, false)
  assert.equal(providerSchema.safeParse({ id: 'other', authMode: 'env', envKey: 'MODEL_KEY', baseUrl: 'https://user:secret@example.invalid' }).success, false)
  assert.equal(providerSchema.safeParse({ id: 'local', authMode: 'none', baseUrl: 'http://127.0.0.1:9000/v1' }).success, true)
  assert.equal(canonicalJson({ second: 2, first: 1 }), canonicalJson({ first: 1, second: 2 }))
})

test('real protocol-only verification records inconclusive evidence and makes zero provider requests', async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-protocol-verification-'))
  const store = new Store(join(root, 'tasks.sqlite'))
  let providerRequests = 0
  const provider = createServer((_request, response) => { providerRequests++; response.writeHead(503); response.end() })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address() as { port: number }
  store.set('repository', { id: 'protocol-fixture' })
  const runtime = new RuntimeController(store, root, configSchema.parse({ version: 3, operatorId: 'human', concurrency: 1, runtime: {} }))
  const service = new RuntimeVerificationService(runtime)
  try {
    await createProfile(root, 'not-a-real-model', { id: 'fixture', authMode: 'none', baseUrl: `http://127.0.0.1:${address.port}/v1` })
    await runtime.check()
    assert.equal(runtime.snapshot().inspection?.auth.status, 'configured')
    assert.equal(runtime.snapshot().inspection?.checks.find(check => check.key === 'effective_profile')!.status, 'passed')
    const diagnostic = await checkWorker(root)
    assert.equal(diagnostic.diagnosticOnly, true)
    assert.equal(diagnostic.accountConfigured, true)
    assert.equal(diagnostic.modelTurnTested, false)
    const preview = service.preview({ expectedRevision: runtime.state().revision, repositoryId: 'protocol-fixture' })
    const result = service.start({ requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId: 'protocol-fixture', confirmation: 'protocol-fixture', reviewId: preview.reviewId, expectedFingerprint: preview.expectedFingerprint, limits: (preview.detail as { limits: unknown }).limits })
    const deadline = Date.now() + 10000
    while (runtime.state().verificationRunId && Date.now() < deadline) await delay(25)
    const verification = service.get({ id: result.id })
    assert.equal(verification.state, 'inconclusive')
    assert.equal(verification.reasonCode, 'VERIFICATION_BUDGET_UNSUPPORTED')
    assert.equal(verification.capabilities.protocol_handshake!.status, 'passed')
    assert.equal(verification.capabilities.authenticated_model_turn!.status, 'not_run')
    assert.equal(providerRequests, 0)
    assert.equal(runtime.status().canDispatch, false)
    assert.equal(verification.validUntil, undefined)
    const evidence = JSON.parse(await readFile(join(root, 'runtime/evidence', verification.id, verification.evidence[0]!.relativePath), 'utf8'))
    assert.equal(evidence.modelTurns, 0)
  } finally { await service.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('T15: explicit offline migration backs up SQLite and profile, preserves task history and never enables', async () => {
  const root = await realpath(await mkdtemp('/tmp/sa-migration-'))
  const state = join(root, 's'), repo = join(root, 'r')
  try {
    await git(root, ['init', repo]); await writeFile(join(repo, 'README'), 'fixture')
    await git(repo, ['add', 'README']); await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'fixture'])
    await initialize(state, repo, join(root, 'w'), 'fixture-model')
    const config = await readConfig(state)
    await writeFile(join(state, 'service.json'), JSON.stringify({ version: 2, operatorId: config.operatorId, concurrency: 1, gitlabEnabled: false }))
    await assert.rejects(readConfig(state), /explicit migration/)
    const lock = await acquireLock(state)
    await assert.rejects(migrateConfig(state), /lock exists/)
    await lock.release()
    await migrateConfig(state)
    assert.equal((await readConfig(state)).version, 3)
    assert.equal((await readdir(join(state, 'backups'))).length, 3)
    const store = new Store(join(state, 'tasks.sqlite'))
    try { assert.equal(store.entities('runtime_enablement').length, 0); assert.equal(store.repository()!.path, repo) } finally { store.close() }
    assert.equal((await loadProfile(state)).version, 2)
    assert.equal(JSON.parse(await readFile(join(state, 'service.json'), 'utf8')).runtime.mode, 'restricted_local')
  } finally { await rm(root, { recursive: true, force: true }) }
})
