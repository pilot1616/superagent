import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requireCondition, type Repository, type Ticket } from '../../core/src/model.js'
import { parseGitLabRemote } from '../../core/src/gitlab.js'
import { workspaceRepository } from '../../core/src/workspace.js'

const execute = promisify(execFile)
export const git = async (directory: string, args: string[]): Promise<string> => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', directory, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
export const inside = (root: string, target: string): boolean => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
export async function registerRepository(path: string, executionRoot: string, baseRef = 'HEAD', gitlabUrl = 'https://gitlab.com'): Promise<Repository> {
  const canonicalPath = await realpath(path)
  requireCondition(await git(canonicalPath, ['rev-parse', '--show-toplevel']) === canonicalPath, 'INVALID_STATE', 'Register a Git repository root')
  requireCondition(!baseRef.startsWith('-') && /^[A-Za-z0-9_./-]+$/.test(baseRef), 'INVALID_STATE', 'Invalid base ref')
  const baseSha = await git(canonicalPath, ['rev-parse', '--verify', `${baseRef}^{commit}`])
  await mkdir(executionRoot, { recursive: true, mode: 0o700 })
  const canonicalExecution = await realpath(executionRoot)
  requireCondition(!inside(canonicalPath, canonicalExecution) && !inside(canonicalExecution, canonicalPath), 'INVALID_STATE', 'Worktree root and registered checkout must not contain each other')
  let remote = ''
  try { remote = await git(canonicalPath, ['remote', 'get-url', 'origin']) } catch {}
  const gitlab = parseGitLabRemote(remote, gitlabUrl)
  return { id: randomUUID(), path: canonicalPath, executionRoot: canonicalExecution, baseRef, baseSha, remote, ...(gitlab ? { gitlab } : {}) }
}
export async function prepareWorkspace(repository: Repository, ticket: Ticket): Promise<{ workspace: string; branch: string; baseSha: string }> {
  requireCondition(await realpath(repository.path) === repository.path && await realpath(repository.executionRoot) === repository.executionRoot, 'FORBIDDEN', 'Repository or execution root changed')
  const configuration = await git(repository.path, ['config', '--local', '--list'])
  requireCondition(!/^(?:filter\.|include\.|includeif\.|core\.(?:attributesfile|fsmonitor)|extensions\.worktreeconfig)/im.test(configuration), 'FORBIDDEN', 'Repository Git filters or included configuration require manual review before worktree creation')
  const binding = ticket.workspaceBinding
  const effective = workspaceRepository(repository, ticket)
  const workspace = join(repository.executionRoot, binding ? `${ticket.id}-${binding.id}` : ticket.id)
  const branch = binding ? `${binding.branchPrefix}/${binding.id}/${ticket.id}` : `superagent/${ticket.id}`
  requireCondition(inside(repository.executionRoot, workspace), 'FORBIDDEN', 'Workspace escapes execution root')
  await git(repository.path, ['check-ref-format', '--branch', branch])
  const required = ticket.assignments?.at(-1)?.inputs?.filter(result => result.kind === 'code').map(result => result.sha!) ?? []
  const baseSha = binding ? effective.baseSha : required.length ? await git(repository.path, ['rev-parse', '--verify', `${repository.baseRef}^{commit}`]) : repository.baseSha
  requireCondition(/^[a-f0-9]{40,64}$/.test(baseSha) && await git(repository.path, ['rev-parse', '--verify', `${baseSha}^{commit}`]) === baseSha, 'WORKSPACE_BASE_MISSING', '固定基线提交不存在，请核对计划工作区配置', 409)
  for (const sha of required) {
    requireCondition(/^[a-f0-9]{40,64}$/.test(sha), 'FORBIDDEN', 'Invalid dependency commit')
    requireCondition(await git(repository.path, ['merge-base', '--is-ancestor', sha, baseSha]).then(() => true, () => false), 'WORKSPACE_DEPENDENCY_MISSING', '已接受的代码依赖不在计划固定基线中；请审查新基线，不会自动合并或切换分支', 409)
  }
  if (ticket.workspace) {
    requireCondition(await realpath(ticket.workspace) === workspace, 'RECONCILIATION_REQUIRED', 'Workspace moved or is missing')
    requireCondition(await git(workspace, ['branch', '--show-current']) === branch, 'RECONCILIATION_REQUIRED', 'Task branch changed')
    if (binding) {
      requireCondition(ticket.baseSha === binding.baseSha && ticket.branch === branch, 'WORKSPACE_BASE_MISMATCH', '已有工作区不符合计划绑定；请预览迁移，不会覆盖现有修改', 409)
      requireCondition(await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']) === await git(repository.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'WORKSPACE_REPOSITORY_MISMATCH', '已有工作区 Git 元数据不属于登记仓库', 409)
      requireCondition(await git(workspace, ['merge-base', '--is-ancestor', binding.baseSha, 'HEAD']).then(() => true, () => false), 'WORKSPACE_BASE_MISMATCH', '已有工作区 HEAD 不包含固定基线', 409)
    }
    for (const sha of required) await git(workspace, ['merge-base', '--is-ancestor', sha, 'HEAD'])
    return { workspace, branch, baseSha: ticket.baseSha! }
  }
  const exists = await lstat(workspace).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  if (exists) {
    const metadata = (await git(repository.path, ['worktree', 'list', '--porcelain'])).split('\n\n').find(record => record.split('\n').includes(`worktree ${workspace}`))
    requireCondition(await realpath(workspace) === workspace && metadata?.split('\n').includes(`branch refs/heads/${branch}`) && !metadata.split('\n').some(line => /^(?:locked|prunable)(?: |$)/.test(line)) && await git(workspace, ['rev-parse', '--show-toplevel']) === workspace && await git(workspace, ['branch', '--show-current']) === branch && await git(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']) === await git(repository.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'RECONCILIATION_REQUIRED', 'Existing workspace ownership is unverified; inspect instead of overwriting')
    requireCondition(await git(workspace, ['rev-parse', 'HEAD']) === baseSha && !(await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])), 'RECONCILIATION_REQUIRED', 'Unbound workspace has changes; inspect instead of overwriting')
    return { workspace, branch, baseSha }
  }
  await git(repository.path, ['worktree', 'add', '-b', branch, workspace, baseSha])
  return { workspace: await realpath(workspace), branch, baseSha }
}
export async function verifyAcceptedCode(repository: Repository, ticket: Ticket): Promise<string> {
  repository = workspaceRepository(repository, ticket)
  const sha = ticket.mergeRequest?.mergedSha
  requireCondition(ticket.mergeRequest?.state === 'merged' && sha && /^[a-f0-9]{40,64}$/.test(sha), 'INVALID_STATE', 'Observe the bound merged MR before accepting code')
  requireCondition(await realpath(repository.path) === repository.path, 'FORBIDDEN', 'Repository moved')
  const baseSha = await git(repository.path, ['rev-parse', '--verify', `${ticket.workspaceBinding?.baseRef ?? repository.baseRef}^{commit}`])
  await git(repository.path, ['merge-base', '--is-ancestor', sha, baseSha])
  return sha
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
  const configuration = await lstat(join(directory, '.codex')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  requireCondition(!configuration, 'FORBIDDEN', 'Worker checkout contains .codex; inspect and explicitly remove execution configuration before running')
  const agents = join(directory, '.agents')
  const agentsInfo = await lstat(agents).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (agentsInfo) {
    requireCondition(agentsInfo.isDirectory() && !agentsInfo.isSymbolicLink(), 'FORBIDDEN', 'Worker .agents must be a real directory containing only repository skills')
    const entries = await readdir(agents)
    requireCondition(entries.every(name => name === 'skills'), 'FORBIDDEN', 'Worker .agents may contain only skills, not execution configuration')
    const root = await realpath(directory)
    const visited = new Set<string>()
    let inspected = 0
    const inspect = async (path: string, ancestors: Set<string>): Promise<void> => {
      requireCondition(++inspected <= 10000, 'FORBIDDEN', 'Worker skill tree exceeds the inspection limit')
      const target = await realpath(path).catch(() => undefined)
      requireCondition(target && inside(root, target), 'FORBIDDEN', 'Worker skill paths must resolve inside the checkout')
      requireCondition(!ancestors.has(target), 'FORBIDDEN', 'Worker skill tree contains a cyclic link')
      if (visited.has(target)) return
      visited.add(target)
      const info = await stat(target)
      requireCondition(info.isDirectory() || info.isFile(), 'FORBIDDEN', 'Worker skills must contain only directories and regular files')
      if (info.isDirectory()) {
        const parents = new Set([...ancestors, target])
        for (const name of await readdir(target)) await inspect(join(target, name), parents)
      }
    }
    if (entries.length) {
      requireCondition((await stat(join(agents, 'skills')).catch(() => undefined))?.isDirectory(), 'FORBIDDEN', 'Worker .agents/skills must resolve to a skill directory')
      await inspect(join(agents, 'skills'), new Set())
    }
  }
  const metadata = await readFile(join(directory, '.git'), 'utf8')
  requireCondition(metadata.startsWith('gitdir: '), 'FORBIDDEN', 'Expected a managed Git worktree')
}
