import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, stat, lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requireCondition, type Repository, type Ticket } from '../../core/src/model.js'

const execute = promisify(execFile)
export const git = async (directory: string, args: string[]): Promise<string> => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', directory, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
export const inside = (root: string, target: string): boolean => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
export async function registerRepository(path: string, executionRoot: string, baseRef = 'HEAD'): Promise<Repository> {
  const canonicalPath = await realpath(path)
  requireCondition(await git(canonicalPath, ['rev-parse', '--show-toplevel']) === canonicalPath, 'INVALID_STATE', 'Register a Git repository root')
  requireCondition(!baseRef.startsWith('-') && /^[A-Za-z0-9_./-]+$/.test(baseRef), 'INVALID_STATE', 'Invalid base ref')
  const baseSha = await git(canonicalPath, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  await mkdir(executionRoot, { recursive: true, mode: 0o700 })
  const canonicalExecution = await realpath(executionRoot)
  requireCondition(!inside(canonicalPath, canonicalExecution), 'INVALID_STATE', 'Worktrees must live outside the registered checkout')
  let remote = ''
  try { remote = await git(canonicalPath, ['remote', 'get-url', 'origin']) } catch {}
  const github = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1]
  return { id: randomUUID(), path: canonicalPath, executionRoot: canonicalExecution, baseRef, baseSha, remote, ...(github ? { github } : {}) }
}
export async function prepareWorkspace(repository: Repository, ticket: Ticket): Promise<{ workspace: string; branch: string; baseSha: string }> {
  requireCondition(await realpath(repository.path) === repository.path && await realpath(repository.executionRoot) === repository.executionRoot, 'FORBIDDEN', 'Repository or execution root changed')
  const workspace = join(repository.executionRoot, ticket.id)
  const branch = `superagent/${ticket.id}`
  requireCondition(inside(repository.executionRoot, workspace), 'FORBIDDEN', 'Workspace escapes execution root')
  if (ticket.workspace) {
    requireCondition(await realpath(ticket.workspace) === workspace, 'RECONCILIATION_REQUIRED', 'Workspace moved or is missing')
    requireCondition(await git(workspace, ['branch', '--show-current']) === branch, 'RECONCILIATION_REQUIRED', 'Task branch changed')
    return { workspace, branch, baseSha: ticket.baseSha! }
  }
  const exists = await lstat(workspace).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  requireCondition(!exists, 'RECONCILIATION_REQUIRED', 'Unbound workspace already exists; inspect instead of overwriting')
  await git(repository.path, ['worktree', 'add', '-b', branch, workspace, repository.baseSha])
  return { workspace: await realpath(workspace), branch, baseSha: repository.baseSha }
}
export async function inspectWorkspace(ticket: Ticket) {
  requireCondition(ticket.workspace && ticket.baseSha, 'INVALID_STATE', 'No prepared workspace')
  const directory = await realpath(ticket.workspace)
  requireCondition(directory === ticket.workspace, 'FORBIDDEN', 'Workspace redirected')
  const status = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all'])
  const headSha = await git(directory, ['rev-parse', 'HEAD'])
  const branch = await git(directory, ['branch', '--show-current'])
  requireCondition(branch === ticket.branch, 'FORBIDDEN', 'Workspace branch differs from task branch')
  const diff = await git(directory, ['diff', '--no-ext-diff', '--no-textconv', '--stat', ticket.baseSha])
  return { headSha, branch, status, diff }
}
export async function rejectWorkspaceConfiguration(directory: string): Promise<void> {
  for (const name of ['.codex', '.agents']) {
    const present = await stat(join(directory, name)).then(() => true, () => false)
    requireCondition(!present, 'FORBIDDEN', `Worker checkout contains ${name}; inspect and explicitly remove execution configuration before running`)
  }
  const metadata = await readFile(join(directory, '.git'), 'utf8')
  requireCondition(metadata.startsWith('gitdir: '), 'FORBIDDEN', 'Expected a managed Git worktree')
}
