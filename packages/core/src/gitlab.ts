import { requireCondition, type GitLabProject } from './model.js'

export function gitlabUrl(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Provide a valid HTTPS GitLab instance URL') }
  requireCondition(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' && /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/?$/.test(value) && parsed.hostname !== 'github.com', 'FORBIDDEN', 'GitLab URL must be an explicit HTTPS origin without credentials, paths or query parameters')
  return parsed.origin
}

export function validateProjectPath(value: string): string {
  requireCondition(typeof value === 'string' && value.split('/').length >= 2 && value.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith('.git') && !part.includes('..')), 'FORBIDDEN', 'Use a canonical GitLab namespace/project path; nested subgroups are supported')
  return value
}

export function validateGitLabProject(project: GitLabProject): GitLabProject {
  requireCondition(project && typeof project === 'object' && typeof project.url === 'string' && typeof project.projectPath === 'string', 'FORBIDDEN', 'A registered GitLab host and project are required')
  requireCondition(gitlabUrl(project.url) === project.url, 'FORBIDDEN', 'GitLab host must be canonical')
  validateProjectPath(project.projectPath)
  return project
}

export function parseGitLabRemote(remote: string, instanceUrl = 'https://gitlab.com'): GitLabProject | undefined {
  const url = gitlabUrl(instanceUrl)
  if (!remote) return undefined
  const instance = new URL(url)
  let projectPath: string | undefined
  if (remote.startsWith(`${url}/`)) projectPath = remote.slice(url.length + 1)
  else if (remote.startsWith(`git@${instance.hostname}:`)) projectPath = remote.slice(`git@${instance.hostname}:`.length)
  else if (remote.startsWith('ssh://')) {
    const ssh = /^ssh:\/\/git@([A-Za-z0-9.-]+)(?::([0-9]+))?\/(.+)$/.exec(remote)
    if (ssh && ssh[1] === instance.hostname && (!ssh[2] || (Number(ssh[2]) > 0 && Number(ssh[2]) <= 65535))) projectPath = ssh[3]
  }
  requireCondition(projectPath, 'FORBIDDEN', 'Origin must match the explicitly configured GitLab host without embedded credentials; use --gitlab-url for a self-managed instance')
  projectPath = validateProjectPath(projectPath.replace(/\.git$/, ''))
  return { url, projectPath }
}
