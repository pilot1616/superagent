import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProfile, loadProfile, workerEnvironment } from '../executor-codex/src/profile.js'
import { capabilitiesInputSchema, prepareCapabilities, skillTree, taskPermissionArguments, workerFilesystem } from '../executor-codex/src/capabilities.js'
import { WorkerRuntime, issueVerificationPermit } from '../executor-codex/src/runtime.js'
import { effectiveProfile } from '../executor-codex/src/inspection.js'
import { git } from '../service/src/workspace.js'
import { acquireLock, configureWorkerProfile, initialize } from '../service/src/config.js'

async function fixture() {
  const root = await realpath(await mkdtemp(join(homedir(), '.sa-caps-test-')))
  const state = join(root, 's'), source = join(root, 'fixture-skill'), workspace = join(root, 'w')
  for (const path of [state, source, workspace]) await mkdir(path, { mode: 0o700 })
  await writeFile(join(source, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Synthetic capability discovery fixture\n---\nUse local test fixtures only.\n')
  return { root, state, source, workspace, close: () => rm(root, { recursive: true, force: true }) }
}

test('explicit skill import snapshots content, preserves sources, and detects snapshot tampering', async () => {
  const context = await fixture()
  try {
    const capabilities = await prepareCapabilities(context.state, { skills: [context.source] }, [])
    const profile = await createProfile(context.state, 'fixture', { id: 'fixture', authMode: 'none', baseUrl: 'http://127.0.0.1:1/v1' }, undefined, capabilities)
    await loadProfile(context.state)
    await writeFile(join(context.source, 'SKILL.md'), 'Source changed independently\n')
    assert.match(await readFile(join(capabilities.skills[0]!.path, 'SKILL.md'), 'utf8'), /Synthetic capability/)
    await loadProfile(context.state)
    const environment = workerEnvironment(profile)
    assert.equal(environment.OPENAI_API_KEY, undefined)
    assert.equal(environment.SSH_AUTH_SOCK, undefined)
    assert.equal(environment.GIT_OPTIONAL_LOCKS, '0')
    await writeFile(join(capabilities.skills[0]!.path, 'SKILL.md'), 'tampered')
    await assert.rejects(loadProfile(context.state), /snapshot changed/)
  } finally { await context.close() }
})

test('reviewed toolchain PATH survives named sandbox shell environment sanitization', { timeout: 15000 }, async () => {
  const context = await fixture()
  try {
    const tools = join(context.root, 'tools')
    await mkdir(tools)
    const executable = join(tools, 'superagent-fixture-tool')
    await writeFile(executable, '#!/bin/sh\nprintf "reviewed-toolchain-command\\n"\n')
    await chmod(executable, 0o700)
    const capabilities = await prepareCapabilities(context.state, { toolchain: { pathEntries: [tools] } }, [])
    const profile = await createProfile(context.state, 'fixture', { id: 'fixture', authMode: 'none', baseUrl: 'http://127.0.0.1:1/v1' }, undefined, capabilities)
    const result = await promisify(execFile)('codex', ['sandbox', '-P', 'superagent-worker', '-C', context.workspace, '--', '/bin/sh', '-c', 'printf "%s\\n" "$PATH"; superagent-fixture-tool'], { env: workerEnvironment(profile), cwd: context.workspace, timeout: 5000 })
    assert.equal(result.stdout.split('\n')[0], workerEnvironment(profile).PATH)
    assert.match(result.stdout, /reviewed-toolchain-command/)
  } finally { await context.close() }
})

test('capability configuration rejects secrets, broad read roots, task workspaces and escaping skills', async () => {
  const context = await fixture()
  try {
    for (const environment of [{ OPENAI_API_KEY: 'secret' }, { SSH_AUTH_SOCK: '/tmp/socket' }, { NODE_OPTIONS: '--require malicious' }]) assert.equal(capabilitiesInputSchema.safeParse({ toolchain: { environment } }).success, false)
    for (const root of [homedir(), context.state, '/']) await assert.rejects(prepareCapabilities(context.state, { toolchain: { readRoots: [root] } }, []), { code: 'FORBIDDEN' })
    await assert.rejects(prepareCapabilities(context.state, { toolchain: { pathEntries: [context.workspace] } }, [context.workspace]), { code: 'FORBIDDEN' })
    await symlink(context.state, join(context.source, 'outside'))
    await assert.rejects(skillTree(context.source), /inside their source/)
    await rm(join(context.source, 'outside'))
    await symlink('.', join(context.source, 'cycle'))
    await assert.rejects(skillTree(context.source), /cyclic/)
    await rm(join(context.source, 'cycle'))
    await writeFile(join(context.source, '.env'), 'TOKEN=not-a-real-secret')
    await assert.rejects(skillTree(context.source), /credentials/)
  } finally { await context.close() }
})

test('real Codex permits trusted local commits while protecting references and other task state', { timeout: 40000 }, async () => {
  const context = await fixture()
  let server: WorkerRuntime | undefined
  try {
    const capabilities = await prepareCapabilities(context.state, { skills: [context.source] }, [])
    const profile = await createProfile(context.state, 'fixture', { id: 'fixture', authMode: 'none', baseUrl: 'http://127.0.0.1:1/v1' }, undefined, capabilities)
    const reference = join(context.state, 'references'), foreign = join(context.state, 'other-task')
    await mkdir(reference); await mkdir(foreign)
    await writeFile(join(reference, 'fixture.txt'), 'task-reference\n')
    await writeFile(join(foreign, 'private.txt'), 'other-task-secret\n')
    await git(context.root, ['init', '-b', 'main', join(context.root, 'repo')])
    await writeFile(join(context.root, 'repo/README'), 'base\n')
    await git(join(context.root, 'repo'), ['add', 'README'])
    await git(join(context.root, 'repo'), ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'base'])
    await rm(context.workspace, { recursive: true })
    await git(join(context.root, 'repo'), ['worktree', 'add', '-b', 'task', context.workspace])
    const common = await realpath(join(context.root, 'repo/.git'))
    const baseline = await git(context.workspace, ['rev-parse', 'HEAD'])
    const sibling = join(context.root, 'sibling')
    await git(join(context.root, 'repo'), ['worktree', 'add', '-b', 'sibling', sibling])
    const permit = issueVerificationPermit('synthetic', 'synthetic', context.workspace, () => {})
    await assert.rejects(WorkerRuntime.create('codex', profile, context.workspace, join(context.workspace, '.tmp'), { kind: 'verification', permit }, [reference], context.root), /common Git directory/)
    await assert.rejects(WorkerRuntime.create('codex', profile, context.workspace, join(context.workspace, '.tmp'), { kind: 'verification', permit }, [reference], foreign), /common Git directory/)
    server = await WorkerRuntime.create('codex', profile, context.workspace, join(context.workspace, '.tmp'), { kind: 'verification', permit }, [reference], common)
    await server.prepare(profile)
    const { config } = await server.request<{ config: any }>('config/read', { includeLayers: false })
    assert.equal(effectiveProfile(config, profile, [reference], common), true)
    assert.equal(effectiveProfile(config, profile, [reference, common]), false)
    assert.equal(effectiveProfile(config, profile), false)
    assert.equal(config.permissions['superagent-worker'].filesystem[common], 'write')
    assert.equal(config.permissions['superagent-worker'].filesystem[reference], 'read')
    assert.equal(config.permissions['superagent-worker'].filesystem[foreign], undefined)
    const discovered = await server.request<any>('skills/list', { cwds: [context.workspace], forceReload: true })
    assert.equal(discovered.data.flatMap((entry: any) => entry.skills).some((skill: any) => skill.name === 'fixture-skill'), true, JSON.stringify(discovered))
    const command = async (args: string[], workspace = context.workspace, references = [reference]) => {
      try {
        const result = await promisify(execFile)('codex', ['sandbox', '-P', 'superagent-worker', '-C', workspace, ...taskPermissionArguments(profile.home, profile.capabilities, references, common), '--', ...args], { cwd: workspace, env: workerEnvironment(profile, join(workspace, '.tmp')), timeout: 5000 })
        return { ...result, exitCode: 0 }
      } catch (error) { const failure = error as Error & { code: number; stdout: string; stderr: string }; return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code } }
    }
    const read = await command(['/bin/cat', join(reference, 'fixture.txt')])
    assert.equal(read.exitCode, 0, JSON.stringify(read))
    assert.match(read.stdout, /task-reference/)
    const skillRead = await command(['/bin/cat', join(capabilities.skills[0]!.path, 'SKILL.md')])
    assert.equal(skillRead.exitCode, 0, JSON.stringify(skillRead))
    assert.match(skillRead.stdout, /Synthetic capability/)
    const denied = await command(['/bin/cat', join(foreign, 'private.txt')])
    assert.notEqual(denied.exitCode, 0)
    const write = await command(['/bin/sh', '-c', 'printf changed > "$1"', 'sh', join(reference, 'fixture.txt')])
    assert.notEqual(write.exitCode, 0)
    assert.equal(await readFile(join(reference, 'fixture.txt'), 'utf8'), 'task-reference\n')
    const status = await command(['git', 'status', '--porcelain'])
    assert.equal(status.exitCode, 0, JSON.stringify(status))
    const edit = await command(['/bin/sh', '-c', 'printf "task change\\n" > README'])
    assert.equal(edit.exitCode, 0, JSON.stringify(edit))
    const stage = await command(['git', 'add', '--', 'README'])
    assert.equal(stage.exitCode, 0, JSON.stringify(stage))
    const commit = await command(['git', '-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'task local commit'])
    assert.equal(commit.exitCode, 0, JSON.stringify(commit))
    const taskHead = await git(context.workspace, ['rev-parse', 'HEAD'])
    assert.notEqual(taskHead, baseline)
    assert.equal(await git(context.workspace, ['rev-parse', 'HEAD^']), baseline)
    assert.equal(await git(context.workspace, ['symbolic-ref', '--short', 'HEAD']), 'task')
    assert.equal(await git(context.workspace, ['status', '--porcelain', '--untracked-files=no']), '')
    assert.equal(await git(sibling, ['rev-parse', 'HEAD']), baseline)
    assert.equal(await readFile(join(sibling, 'README'), 'utf8'), 'base\n')
    const siblingEdit = await command(['/bin/sh', '-c', 'printf "sibling change\\n" > README'], sibling, [])
    assert.equal(siblingEdit.exitCode, 0, JSON.stringify(siblingEdit))
    const siblingStage = await command(['git', 'add', '--', 'README'], sibling, [])
    assert.equal(siblingStage.exitCode, 0, JSON.stringify(siblingStage))
    const siblingCommit = await command(['git', '-c', 'user.name=Test', '-c', 'user.email=test@invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'sibling local commit'], sibling, [])
    assert.equal(siblingCommit.exitCode, 0, JSON.stringify(siblingCommit))
    assert.notEqual(await git(sibling, ['rev-parse', 'HEAD']), baseline)
    assert.equal(await git(context.workspace, ['rev-parse', 'HEAD']), taskHead)
    assert.equal(await git(join(context.root, 'repo'), ['rev-parse', 'main']), baseline)
    assert.equal(await readFile(join(context.workspace, 'README'), 'utf8'), 'task change\n')
    await server.close(); server = undefined
    await loadProfile(context.state)
  } finally { await server?.close(); await context.close() }
})

test('Git write grants work without references and leave the default profile unchanged', () => {
  const home = '/fixture/state/home', common = '/fixture/repo/.git', reference = '/fixture/state/references'
  assert.deepEqual(taskPermissionArguments(home, undefined, []), [])
  const args = taskPermissionArguments(home, undefined, [], common)
  assert.ok(args.some(value => value.includes(`${JSON.stringify(common)}="write"`)))
  assert.ok(args.includes('permissions.superagent-worker.network.enabled=false'))
  const filesystem = workerFilesystem(home, undefined, [reference, common], common)
  assert.equal(filesystem[common], 'write')
  assert.equal(filesystem[reference], 'read')
  assert.equal(filesystem['/fixture/state'], 'deny')
  assert.equal(workerFilesystem(home, undefined, [common])[common], 'read')
})

test('offline capability upgrade preserves model/provider and refuses a running service lock', async () => {
  const context = await fixture()
  try {
    const repository = join(context.root, 'repo')
    await git(context.root, ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'README'), 'base\n')
    await git(repository, ['add', 'README'])
    await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-m', 'base'])
    await initialize(context.state, repository, join(context.root, 'worktrees'), 'original-model')
    const provider = { id: 'fixture', authMode: 'none' as const, baseUrl: 'http://127.0.0.1:1/v1' }
    await createProfile(context.state, 'original-model', provider)
    const lock = await acquireLock(context.state)
    try { await assert.rejects(configureWorkerProfile(context.state, { skills: [context.source] }, true), /lock exists/) } finally { await lock.release() }
    const result = await configureWorkerProfile(context.state, { skills: [context.source] }, true)
    const profile = await loadProfile(context.state)
    assert.equal(profile.model, 'original-model')
    assert.deepEqual(profile.provider, provider)
    assert.equal(result.executionEnabled, false)
    assert.equal(profile.capabilities?.skills[0]?.name, 'fixture-skill')
  } finally { await context.close() }
})
