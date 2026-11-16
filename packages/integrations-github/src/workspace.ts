import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, lstat, rm, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireCondition, type PublishPreview, type Repository, type Ticket } from '../../core/src/model.js'
import { digest } from '../../storage/src/store.js'
import { inside, inspectWorkspace } from '../../service/src/workspace.js'

const execute = promisify(execFile)
const safeEnvironment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' })
export async function deliveryGit(directory: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', '-c', 'commit.gpgsign=false', '-C', directory, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000, env: { ...safeEnvironment(), ...extra } })).stdout.trimEnd()
  } catch { throw new Error('Controlled Git operation failed; inspect local and remote state before retrying') }
}
async function checkRepository(repository: Repository, ticket: Ticket): Promise<void> {
  requireCondition(repository.github && ticket.workspace && ticket.branch && ticket.baseSha, 'INVALID_STATE', 'GitHub repository and managed workspace are required')
  requireCondition(!['HEAD', 'FETCH_HEAD'].includes(repository.baseRef) && !repository.baseRef.startsWith('refs/'), 'INVALID_STATE', 'Register a named GitHub base branch, such as main, before publishing')
  requireCondition(await realpath(ticket.workspace) === join(await realpath(repository.executionRoot), ticket.id), 'FORBIDDEN', 'Workspace does not match its registered root')
  const configuration = await deliveryGit(ticket.workspace, ['config', '--local', '--list'])
  requireCondition(!/^(?:filter\.|url\.|include\.|includeif\.|credential\.|http\.|core\.(?:sshcommand|gitproxy|attributesfile|fsmonitor)|extensions\.worktreeconfig)/im.test(configuration), 'FORBIDDEN', 'Unsafe or unsupported local Git configuration; publication requires manual review')
  const pointer = await readFile(join(ticket.workspace, '.git'), 'utf8')
  const common = await deliveryGit(ticket.workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const repositoryCommon = await deliveryGit(repository.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  requireCondition(common === repositoryCommon && pointer.startsWith(`gitdir: ${repositoryCommon}/worktrees/`), 'FORBIDDEN', 'Worktree metadata changed')
  requireCondition(await deliveryGit(ticket.workspace, ['remote', 'get-url', 'origin']) === repository.remote, 'FORBIDDEN', 'Registered remote changed')
}
export async function previewWorkspace(repository: Repository, ticket: Ticket, state: string, authorName: string, authorEmail: string): Promise<PublishPreview> {
  requireCondition(authorName.length > 0 && authorName.length <= 100 && !/[\r\n<>]/.test(authorName) && /^[^\s<>@]+@[^\s<>@]+$/.test(authorEmail), 'INVALID_REQUEST', 'Provide an explicit valid commit author name and email')
  await checkRepository(repository, ticket)
  const inspected = await inspectWorkspace(ticket)
  const temp = await mkdtemp(join(state, 'preview-'))
  const env = { GIT_INDEX_FILE: join(temp, 'index') }
  try {
    const files = (await deliveryGit(ticket.workspace!, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    for (const name of new Set(files)) {
      requireCondition(inside(ticket.workspace!, join(ticket.workspace!, name)), 'FORBIDDEN', 'File escaped the workspace')
      const info = await lstat(join(ticket.workspace!, name)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!info) continue
      requireCondition(info.isFile() && !info.isSymbolicLink() && inside(ticket.workspace!, await realpath(join(ticket.workspace!, name))), 'FORBIDDEN', 'Symlinks, submodules and special files require manual delivery')
      requireCondition(info.size <= 20_000_000, 'FORBIDDEN', 'Review large files separately before publishing')
    }
    await deliveryGit(ticket.workspace!, ['read-tree', inspected.headSha], env)
    await deliveryGit(ticket.workspace!, ['add', '-A', '--', '.'], env)
    const treeSha = await deliveryGit(ticket.workspace!, ['write-tree'], env)
    const diff = await deliveryGit(ticket.workspace!, ['diff', '--no-ext-diff', '--no-textconv', '--stat', ticket.baseSha!, treeSha])
    const content = { ticketId: ticket.id, revision: ticket.revision, repository: repository.github!, branch: ticket.branch!, baseRef: repository.baseRef, baseSha: ticket.baseSha!, headSha: inspected.headSha, treeSha, diff, title: ticket.title, body: `Task: ${ticket.id}\n\n${ticket.report?.summary ?? ''}\n\nChecks reported by Worker (not independently verified):\n${ticket.report?.checks.map(check => `- ${check}`).join('\n') ?? ''}`, authorName, authorEmail }
    return { ...content, fingerprint: digest(content) }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
export async function commitPreview(ticket: Ticket, preview: PublishPreview): Promise<string> {
  const existingTree = await deliveryGit(ticket.workspace!, ['rev-parse', 'HEAD^{tree}'])
  if (existingTree === preview.treeSha) return preview.headSha
  const identity = { GIT_AUTHOR_NAME: preview.authorName, GIT_AUTHOR_EMAIL: preview.authorEmail, GIT_COMMITTER_NAME: preview.authorName, GIT_COMMITTER_EMAIL: preview.authorEmail }
  const commit = await deliveryGit(ticket.workspace!, ['commit-tree', preview.treeSha, '-p', preview.headSha, '-m', preview.title], identity)
  await deliveryGit(ticket.workspace!, ['update-ref', `refs/heads/${preview.branch}`, commit, preview.headSha])
  await deliveryGit(ticket.workspace!, ['read-tree', commit])
  return commit
}
export async function pushCommit(ticket: Ticket, preview: PublishPreview, commit: string, token: string): Promise<void> {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64')
  await deliveryGit(ticket.workspace!, ['push', '--porcelain', `https://github.com/${preview.repository}.git`, `${commit}:refs/heads/${preview.branch}`], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}` })
}
