import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, readlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, registerRepository, prepareWorkspace, rejectWorkspaceConfiguration } from '../service/src/workspace.js'
import type { Ticket } from '../core/src/model.js'

async function fixture(setup: (repository: string) => Promise<void> = async () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-workspace-')))
  const repository = join(root, 'repo')
  await git(root, ['init', '-b', 'main', repository])
  await writeFile(join(repository, 'file.txt'), 'baseline\n')
  await writeFile(join(repository, '.gitignore'), 'ignored.txt\n')
  await setup(repository)
  await git(repository, ['add', '.'])
  await git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'])
  const registered = await registerRepository(repository, join(root, 'work'))
  const ticket = { id: 'fixture-task' } as Ticket
  const prepared = await prepareWorkspace(registered, ticket)
  return { root, repository, registered, ticket, prepared }
}

test('worktrees use fixed base commits without editing the user checkout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'superagent-git-'))
  try {
    const repo = join(temporary, 'repo')
    await mkdir(repo)
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'user.email', 'test@example.invalid'])
    await writeFile(join(repo, 'file.txt'), 'baseline\n')
    await git(repo, ['add', 'file.txt'])
    await git(repo, ['commit', '-m', 'baseline'])
    const registered = await registerRepository(repo, join(temporary, 'work'))
    const prepared = await prepareWorkspace(registered, { id: 'test-ticket' } as Ticket)
    assert.equal(await git(repo, ['branch', '--show-current']), 'main')
    assert.equal(await git(prepared.workspace, ['rev-parse', 'HEAD']), registered.baseSha)
    await rejectWorkspaceConfiguration(prepared.workspace)
    await mkdir(join(prepared.workspace, '.codex'))
    await assert.rejects(rejectWorkspaceConfiguration(prepared.workspace), /execution configuration/)
    await assert.rejects(prepareWorkspace(registered, { id: '../escape' } as Ticket), /escapes/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

for (const linked of [false, true]) {
  test(`repository skills are allowed without deleting user files (${linked ? 'internal link' : 'directory'})`, async () => {
    const context = await fixture(async repository => {
      await mkdir(join(repository, '.agents'), { recursive: true })
      const skillDirectory = linked ? 'skills' : '.agents/skills'
      await mkdir(join(repository, skillDirectory, 'fixture'), { recursive: true })
      await writeFile(join(repository, skillDirectory, 'fixture/SKILL.md'), '---\nname: fixture\ndescription: Test skill\n---\nRepository skill data\n')
      if (linked) await symlink('../skills', join(repository, '.agents/skills'))
    })
    try {
      await rejectWorkspaceConfiguration(context.prepared.workspace)
      assert.equal(await git(context.prepared.workspace, ['status', '--porcelain=v1']), '')
      assert.equal(await git(context.repository, ['status', '--porcelain=v1']), '')
      if (linked) assert.equal(await readlink(join(context.prepared.workspace, '.agents/skills')), '../skills')
      assert.match(await readFile(join(context.repository, '.agents/skills/fixture/SKILL.md'), 'utf8'), /Repository skill data/)
    } finally { await rm(context.root, { recursive: true, force: true }) }
  })
}

for (const kind of ['execution-config', 'linked-agents', 'external-skills', 'nested-escape', 'broken-link', 'cycle']) {
  test(`unsafe project agent paths remain blocked: ${kind}`, async () => {
    const context = await fixture()
    try {
      const workspace = context.prepared.workspace
      if (kind === 'linked-agents') await symlink(context.root, join(workspace, '.agents'))
      else {
        await mkdir(join(workspace, '.agents/skills'), { recursive: true })
        if (kind === 'execution-config') await writeFile(join(workspace, '.agents/config.toml'), 'unsafe = true')
        if (kind === 'external-skills') { await rm(join(workspace, '.agents/skills'), { recursive: true }); await symlink(context.root, join(workspace, '.agents/skills')) }
        if (kind === 'nested-escape') await symlink(context.root, join(workspace, '.agents/skills/assets'))
        if (kind === 'broken-link') await symlink('missing', join(workspace, '.agents/skills/broken'))
        if (kind === 'cycle') await symlink('.', join(workspace, '.agents/skills/cycle'))
      }
      await assert.rejects(rejectWorkspaceConfiguration(workspace), { code: 'FORBIDDEN' })
    } finally { await rm(context.root, { recursive: true, force: true }) }
  })
}

test('a clean unbound managed worktree from a failed preflight can be reused', async () => {
  const context = await fixture()
  try {
    assert.deepEqual(await prepareWorkspace(context.registered, context.ticket), context.prepared)
    assert.equal(await git(context.repository, ['branch', '--show-current']), 'main')
    assert.equal(await git(context.prepared.workspace, ['status', '--porcelain=v1']), '')
  } finally { await rm(context.root, { recursive: true, force: true }) }
})

for (const file of ['file.txt', 'untracked.txt', 'ignored.txt']) {
  test(`unbound worktree changes are preserved and require reconciliation: ${file}`, async () => {
    const context = await fixture()
    try {
      await writeFile(join(context.prepared.workspace, file), 'preserve this edit\n')
      await assert.rejects(prepareWorkspace(context.registered, context.ticket), { code: 'RECONCILIATION_REQUIRED' })
      assert.equal(await readFile(join(context.prepared.workspace, file), 'utf8'), 'preserve this edit\n')
    } finally { await rm(context.root, { recursive: true, force: true }) }
  })
}

test('a worktree on an unexpected branch is not adopted', async () => {
  const context = await fixture()
  try {
    await git(context.prepared.workspace, ['switch', '-c', 'other'])
    await assert.rejects(prepareWorkspace(context.registered, context.ticket), { code: 'RECONCILIATION_REQUIRED' })
  } finally { await rm(context.root, { recursive: true, force: true }) }
})

test('a locked worktree is not adopted', async () => {
  const context = await fixture()
  try {
    await git(context.repository, ['worktree', 'lock', context.prepared.workspace])
    await assert.rejects(prepareWorkspace(context.registered, context.ticket), { code: 'RECONCILIATION_REQUIRED' })
  } finally { await rm(context.root, { recursive: true, force: true }) }
})
