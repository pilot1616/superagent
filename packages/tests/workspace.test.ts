import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, registerRepository, prepareWorkspace, rejectWorkspaceConfiguration } from '../service/src/workspace.js'
import type { Ticket } from '../core/src/model.js'

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
