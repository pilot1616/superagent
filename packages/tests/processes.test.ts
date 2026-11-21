import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createProcessObserver, processSnapshot, ProcessTracker, type ProcessIdentity } from '../executor-codex/src/processes.js'

const leader: ProcessIdentity = { pid: 100, parent: 1, group: 100, start: 'original' }
const snapshot = (...identities: ProcessIdentity[]) => new Map(identities.map(identity => [identity.pid, identity]))

test('the host observer captures the current process without requiring an interactive terminal', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const current = (await processSnapshot()).get(process.pid)
  assert.equal(current?.pid, process.pid)
  assert.equal(current?.parent, process.ppid)
  assert.ok(current?.start)
})

test('concurrent snapshot requests share one asynchronous observer', async () => {
  const observe = createProcessObserver(process.execPath, ['-e', 'setTimeout(()=>console.log("100 1 100 original"),50)'])
  const first = observe()
  assert.equal(observe(), first)
  await delay(10)
  assert.equal(observe(), first)
  assert.deepEqual(await first, snapshot(leader))
  assert.notEqual(observe(), first)
  await observe()
})

test('a hung observer times out without blocking the event loop', { timeout: 5000 }, async () => {
  const observe = createProcessObserver(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100)
  const first = observe()
  const rejected = assert.rejects(first, { code: 'PROCESS_OBSERVATION_FAILED' })
  await delay(10)
  assert.equal(observe(), first)
  await rejected
})

for (const output of ['', 'invalid', '100 1 100 original\n100 1 100 duplicate', '9007199254740992 1 1 original', '0 1 1 original']) {
  test(`invalid process observation fails closed: ${JSON.stringify(output)}`, async () => {
    const observe = createProcessObserver(process.execPath, ['-e', `console.log(${JSON.stringify(output)})`])
    await assert.rejects(observe(), { code: 'PROCESS_OBSERVATION_FAILED' })
  })
}

test('an unavailable observer fails closed instead of silently using another command', async () => {
  const observe = createProcessObserver('/nonexistent-superagent-observer', [])
  await assert.rejects(observe(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('nonzero observer exit rejects even if its partial output appears valid', async () => {
  const observe = createProcessObserver(process.execPath, ['-e', 'console.log("100 1 100 original");process.exitCode=1'])
  await assert.rejects(observe(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('excessive process output fails closed', async () => {
  const observe = createProcessObserver(process.execPath, ['-e', 'process.stdout.write("x".repeat(4_000_001))'])
  await assert.rejects(observe(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('slow process observation leaves the event loop responsive and coalesces samples', async () => {
  let calls = 0
  let complete!: (value: Map<number, ProcessIdentity>) => void
  const pending = new Promise<Map<number, ProcessIdentity>>(resolve => { complete = resolve })
  const tracker = new ProcessTracker(leader.pid, () => { calls++; return pending })
  const first = tracker.sample()
  assert.equal(tracker.sample(), first)
  await delay(10)
  assert.equal(calls, 1)
  assert.equal(tracker.observed.size, 0)
  complete(snapshot(leader))
  await first
  assert.deepEqual(tracker.observed.get(leader.pid), leader)
  await tracker.assertOwnedGroup()
})

test('a failed observation remains fail-closed even after a later successful scan', async () => {
  let fail = true
  const tracker = new ProcessTracker(leader.pid, async () => {
    if (fail) throw new Error('Fixture timeout')
    return snapshot(leader)
  })
  await tracker.sample()
  fail = false
  await assert.rejects(tracker.assertOwnedGroup(), { code: 'PROCESS_OBSERVATION_FAILED' })
  await assert.rejects(tracker.groupAbsent(), { code: 'PROCESS_OBSERVATION_FAILED' })
  await assert.rejects(tracker.assertNoObservedEscape(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('asynchronous observations still reject reused leader PIDs', async () => {
  let current = snapshot(leader)
  const tracker = new ProcessTracker(leader.pid, async () => current)
  await tracker.sample()
  current = snapshot({ ...leader, start: 'replacement' })
  await assert.rejects(tracker.assertOwnedGroup(), /PID was reused/)
})

test('initialization cannot proceed before the original process identity is captured', async () => {
  const tracker = new ProcessTracker(leader.pid, async () => snapshot())
  await assert.rejects(tracker.assertOwnedGroup(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('a shared snapshot taken before launch is refreshed before verifying a new Worker', async () => {
  let calls = 0
  const tracker = new ProcessTracker(leader.pid, async () => ++calls === 1 ? snapshot() : snapshot(leader))
  await tracker.assertOwnedGroup()
  assert.equal(calls, 2)
  assert.deepEqual(tracker.observed.get(leader.pid), leader)
})

test('asynchronous observations do not treat surviving escaped descendants as clean', async () => {
  const descendant: ProcessIdentity = { pid: 101, parent: leader.pid, group: 101, start: 'child' }
  let current = snapshot(leader, descendant)
  const tracker = new ProcessTracker(leader.pid, async () => current)
  await tracker.sample()
  current = snapshot({ ...descendant, parent: 1 })
  assert.equal(await tracker.groupAbsent(), true)
  await assert.rejects(tracker.assertNoObservedEscape(), /descendant escaped or survived/)
})

test('unrelated protected processes remain visible for process-group absence checks', async () => {
  const protectedProcess = { pid: 200, parent: 1, group: leader.pid, start: 'unavailable' }
  const tracker = new ProcessTracker(leader.pid, async () => snapshot(leader, protectedProcess))
  await tracker.assertOwnedGroup()
  assert.equal(await tracker.groupAbsent(), false)
})

test('an inaccessible group leader cannot be used to initialize or signal a Worker', async () => {
  const tracker = new ProcessTracker(leader.pid, async () => snapshot({ ...leader, start: 'unavailable' }))
  await assert.rejects(tracker.assertOwnedGroup(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('a newly discovered inaccessible descendant fails closed', async () => {
  const tracker = new ProcessTracker(leader.pid, async () => snapshot(leader, { pid: 101, parent: leader.pid, group: leader.pid, start: 'unavailable' }))
  await assert.rejects(tracker.assertOwnedGroup(), { code: 'PROCESS_OBSERVATION_FAILED' })
})

test('a known descendant becoming inaccessible cannot be mistaken for a reused or absent PID', async () => {
  const descendant = { pid: 101, parent: leader.pid, group: leader.pid, start: 'child' }
  let current = snapshot(leader, descendant)
  const tracker = new ProcessTracker(leader.pid, async () => current)
  await tracker.sample()
  current = snapshot({ ...descendant, parent: 1, group: 101, start: 'unavailable' })
  await assert.rejects(tracker.assertNoObservedEscape(), { code: 'PROCESS_OBSERVATION_FAILED' })
})
