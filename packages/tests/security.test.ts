import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Store } from '../storage/src/store.js'
import { Engine } from '../core/src/engine.js'
import type { Ticket } from '../core/src/model.js'
import { CodexExecutor } from '../executor-codex/src/executor.js'
import { executionVerified } from '../executor-codex/src/acceptance.js'
import { createProfile, loadProfile, workerEnvironment } from '../executor-codex/src/profile.js'
import { startPanel } from '../service/src/panel.js'
import { acquireLock } from '../service/src/config.js'

function taskFixture() {
  const store = new Store(':memory:')
  store.set('repository', { id: 'repo', path: '/repo', executionRoot: '/worktrees', baseRef: 'main', baseSha: 'a'.repeat(40), remote: '' })
  const engine = new Engine(store, 'operator')
  const { ticket } = engine.call('task_create', { repositoryId: 'repo', title: 'Fixture', request: 'Manual scope', requestId: randomUUID() }) as { ticket: Ticket }
  return { store, engine, ticket }
}
test('stale authorizations expire and cannot strand or authorize a changed task', () => {
  const { store, engine, ticket } = taskFixture()
  try {
    engine.call('task_start', { ticketId: ticket.id, expectedRevision: 1, requestId: randomUUID() })
    const approval = store.approvals()[0]!
    engine.call('task_message', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, text: 'Changed scope detail', requestId: randomUUID() })
    assert.throws(() => engine.approve(approval.id, true), /revision/)
    engine.expireApprovals()
    assert.equal(store.approval(approval.id)?.status, 'expired')
    engine.call('task_start', { ticketId: ticket.id, expectedRevision: engine.require(ticket.id).revision, requestId: randomUUID() })
    assert.equal(store.approvals().filter(entry => entry.status === 'pending').length, 1)
    assert.equal(store.effects().length, 0)
  } finally { store.close() }
})
test('real Worker gate fails before worktree preparation or process creation', async () => {
  const { store, engine, ticket } = taskFixture()
  try {
    assert.equal(executionVerified(), false)
    const executor = new CodexExecutor(store, engine, '/state-that-does-not-exist', 'binary-that-does-not-exist')
    await assert.rejects(() => executor.launch(ticket), /P0 runtime acceptance/)
    assert.equal(executor.active.size, 0)
    assert.equal(engine.require(ticket.id).workspace, undefined)
  } finally { store.close() }
})
test('Worker environment excludes inherited secrets and detects edited configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-profile-')))
  try {
    const profile = await createProfile(root, 'explicit-test-model')
    assert.deepEqual(Object.keys(workerEnvironment(profile)).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR'])
    assert.equal((await loadProfile(root)).hash, profile.hash)
    await writeFile(join(profile.home, '.codex/config.toml'), 'approval_policy="never"')
    await assert.rejects(() => loadProfile(root), /configuration changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('administrative approvals reject noninteractive model shell calls', async () => {
  await assert.rejects(() => promisify(execFile)(process.execPath, ['dist/service/src/cli.js', 'approve', 'not-an-approval'], { cwd: process.cwd(), timeout: 5000 }), error => {
    assert.match(String((error as { stderr: string }).stderr), /interactive terminal/)
    return true
  })
})
test('lock ownership changes are detected without deleting another owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sa-lock-'))
  try {
    const lock = await acquireLock(root)
    assert.equal(lock.owned(), true)
    await writeFile(join(root, 'daemon.lock/owner.json'), JSON.stringify({ owner: 'replacement', pid: process.pid }))
    assert.equal(lock.owned(), false)
    await lock.release()
    assert.equal(JSON.parse(await readFile(join(root, 'daemon.lock/owner.json'), 'utf8')).owner, 'replacement')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('panel binds loopback, validates origin and host, and exposes no mutation API', async () => {
  const panel = await startPanel('/missing-service')
  try {
    const page = await fetch(panel.origin)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal((await fetch(`${panel.origin}/api/health`)).status, 401)
    const rebindingStatus = await new Promise<number>(resolve => { const connection = request(panel.origin, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode!) }); connection.end() })
    assert.equal(rebindingStatus, 403)
    assert.equal((await fetch(`${panel.origin}/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ token: panel.loginSecret }) })).status, 403)
    const login = await fetch(`${panel.origin}/login`, { method: 'POST', headers: { origin: panel.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: panel.loginSecret }) })
    assert.equal(login.status, 200)
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    assert.equal((await fetch(`${panel.origin}/api/decide`, { method: 'POST', headers: { cookie, origin: panel.origin } })).status, 405)
    assert.equal((await fetch(`${panel.origin}/api/admin`, { headers: { cookie } })).status, 404)
  } finally { await panel.close() }
})
