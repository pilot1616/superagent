import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initialize } from '../service/src/config.js'
import { startService } from '../service/src/daemon.js'
import { git } from '../service/src/workspace.js'
import { createProfile } from '../executor-codex/src/profile.js'
import type { Ticket, WorkerAgent } from '../core/src/model.js'

test('real Codex spawns two native children, exchanges results and closes them through a loopback-only provider', { timeout: 40_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-native-agents-')))
  const state = join(root, 's'), repository = join(root, 'r')
  let parentStep = 0
  let childRequests = 0
  let requestCount = 0
  let rootCacheKey: string | undefined
  const providerErrors: string[] = []
  const report = { state: 'ready', summary: 'Both fixture children returned results', checks: ['Synthetic local collaboration only'] }
  const provider = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk.toString() })
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/responses')
        assert.ok(++requestCount <= 12, 'Fixture model loop exceeded bound')
        const body = JSON.parse(raw)
        assert.equal(body.model, 'gpt-6-astra')
        assert.equal(typeof body.prompt_cache_key, 'string')
        rootCacheKey ??= body.prompt_cache_key
        const child = body.client_metadata?.thread_id !== rootCacheKey
        const calls: { name: string; arguments: unknown }[] = []
        let text: string | undefined
        if (child) { childRequests++; text = 'LOCAL_CHILD_RESULT: reviewed assigned files' }
        else if (parentStep++ === 0) {
          assert.ok(JSON.stringify(body.tools ?? body.input).includes('spawn_agent'), 'Native subagent tools are absent')
          calls.push({ name: 'spawn_agent', arguments: { task_name: 'review_a', fork_turns: 'none', message: 'LOCAL_CHILD_FIXTURE_A: analyze README only; do not modify files.' } }, { name: 'spawn_agent', arguments: { task_name: 'review_b', fork_turns: 'none', message: 'LOCAL_CHILD_FIXTURE_B: review README independently; do not modify files.' } })
        } else {
          const outputs = body.input?.filter((item: any) => item.type === 'function_call_output') ?? []
          if (parentStep === 2) {
            assert.equal(outputs.filter((item: any) => String(item.output).includes('task_name')).length, 2, `Fixture did not receive two native spawn results: ${JSON.stringify({ outputs, requestCount, input: body.input.map((item: any) => ({ type: item.type, role: item.role, text: item.content?.map((entry: any) => entry.text?.slice(-500)) })) })}`)
            calls.push({ name: 'wait_agent', arguments: { timeout_ms: 10_000 } })
          } else if (service?.store.entities<WorkerAgent>('worker_agent').filter(agent => agent.status === 'completed').length !== 2) calls.push({ name: 'wait_agent', arguments: { timeout_ms: 10_000 } })
          else text = JSON.stringify(report)
        }
        const responseId = `response-${requestCount}`
        const output = text === undefined ? calls.map((call, index) => ({ type: 'function_call', id: `item-${requestCount}-${index}`, call_id: `call-${requestCount}-${index}`, namespace: 'collaboration', name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' })) : [{ type: 'message', id: `message-${requestCount}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed' }]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(value as object) })}\n\n`)
        emit('response.created', { response: { id: responseId, status: 'in_progress', output: [] } })
        for (const [index, item] of output.entries()) emit('response.output_item.done', { output_index: index, item })
        emit('response.completed', { response: { id: responseId, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
        response.end()
      } catch (error) {
        providerErrors.push(String(error))
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'Local fixture rejected the protocol request' } }))
      }
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  let service: Awaited<ReturnType<typeof startService>> | undefined
  try {
    await git(root, ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'README'), 'Disposable native multi-agent fixture\n')
    await git(repository, ['add', 'README']); await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
    await initialize(state, repository, join(root, 'w'), 'gpt-6-astra')
    await createProfile(state, 'gpt-6-astra', { id: 'fixture', authMode: 'none', baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` })
    service = await startService(state)
    await service.runtime.check()
    assert.equal(service.runtime.status().phase, 'ready')
    const repositoryId = service.store.repository()!.id
    const { ticket } = service.engine.call('task_create', { repositoryId, title: 'Native child fixture', request: 'Exercise only the local fixture, not a real model', requestId: randomUUID() }) as { ticket: Ticket }
    service.engine.call('task_start', { ticketId: ticket.id, expectedRevision: ticket.revision, requestId: randomUUID() })
    service.engine.approve(service.store.approvals(ticket.id)[0]!.id, true)
    const preview = service.runtime.preview('enable', { repositoryId, expectedRevision: service.runtime.state().revision })
    assert.equal(preview.agents?.maxConcurrent, 3)
    service.runtime.enable({ requestId: randomUUID(), expectedRevision: preview.expectedRevision, repositoryId, confirmation: repositoryId, reviewId: preview.reviewId, mode: 'restricted_local', expectedFingerprint: preview.expectedFingerprint, reason: 'Disposable native subagent fixture' })
    const deadline = Date.now() + 28_000
    while (Date.now() < deadline && !service.engine.require(ticket.id).report && !service.engine.require(ticket.id).failure && !service.engine.require(ticket.id).reconciliation && !providerErrors.length) await delay(25)
    const current = service.engine.require(ticket.id)
    assert.equal(providerErrors.length, 0, providerErrors.join('\n'))
    assert.equal(current.report?.summary, report.summary, JSON.stringify({ failure: current.failure, reconciliation: current.reconciliation, parentStep, childRequests, requestCount, agents: service.store.entities('worker_agent'), events: service.store.events(ticket.id).slice(-8) }))
    assert.equal(childRequests, 2)
    const agents = service.store.entities<WorkerAgent>('worker_agent')
    assert.equal(agents.length, 2)
    assert.ok(agents.every(agent => agent.parentThreadId === current.binding!.threadId && agent.cleanup === 'closed' && agent.status === 'completed' && agent.summary?.includes('LOCAL_CHILD_RESULT')))
    assert.equal(current.result, undefined)
  } finally {
    await service?.close()
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
