import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { validateGitLabProject } from '../../core/src/gitlab.js'
import { requireCondition, type GitLabProject, type MergeRequest } from '../../core/src/model.js'

const positiveId = z.number().int().positive()
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const mergeRequestSchema = z.object({ iid: positiveId, project_id: positiveId, source_project_id: positiveId, target_project_id: positiveId, source_branch: z.string(), target_branch: z.string(), sha, web_url: z.string(), state: z.enum(['opened', 'locked', 'merged', 'closed']), merge_commit_sha: sha.nullable().optional(), squash_commit_sha: sha.nullable().optional() })
export type MergeRequestRecord = z.infer<typeof mergeRequestSchema>
export interface Feedback { key: string; text: string }
export interface GitLabPort {
  find(project: GitLabProject, branch: string): Promise<MergeRequestRecord[]>
  create(project: GitLabProject, input: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<MergeRequestRecord>
  read(project: GitLabProject, iid: number): Promise<MergeRequestRecord>
  feedback(project: GitLabProject, iid: number, headSha: string): Promise<Feedback[]>
}
export function validateMergeRequest(raw: MergeRequestRecord, project: GitLabProject, branch: string, baseRef: string): MergeRequest {
  validateGitLabProject(project)
  const parsed = mergeRequestSchema.safeParse(raw)
  requireCondition(parsed.success, 'FORBIDDEN', 'Invalid GitLab MR identity or state')
  const record = parsed.data
  requireCondition(record.source_project_id === record.project_id && record.target_project_id === record.project_id && record.source_branch === branch && record.target_branch === baseRef, 'FORBIDDEN', 'MR project, branch or base does not match the registered task; fork delivery is not supported')
  requireCondition(record.web_url === `${project.url}/${project.projectPath}/-/merge_requests/${record.iid}`, 'FORBIDDEN', 'MR URL does not match the registered host and project')
  return { iid: record.iid, url: record.web_url, headSha: record.sha, branch, state: record.state === 'merged' ? 'merged' : record.state === 'closed' ? 'closed' : 'open', ...(record.state === 'merged' ? { mergedSha: record.merge_commit_sha ?? record.squash_commit_sha ?? record.sha } : {}) }
}

export class GitLabHttp implements GitLabPort {
  constructor(private state: string, private registered?: GitLabProject, private transport: typeof fetch = fetch) {}
  async token(): Promise<string> {
    const info = await lstat(join(this.state, 'gitlab.token'))
    requireCondition(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'GitLab credential must be an owner-only regular file')
    const token = (await readFile(join(this.state, 'gitlab.token'), 'utf8')).trim()
    requireCondition(token.length > 10 && !/\s/.test(token), 'RUNTIME_UNAVAILABLE', 'Configure a restricted GitLab access token in the private service state directory')
    return token
  }
  private async request(project: GitLabProject, suffix = '', body?: unknown): Promise<{ data: unknown; nextPage: string | null }> {
    validateGitLabProject(project)
    requireCondition(this.registered && project.url === this.registered.url && project.projectPath === this.registered.projectPath, 'FORBIDDEN', 'GitLab destination differs from the registered host and project')
    const response = await this.transport(`${project.url}/api/v4/projects/${encodeURIComponent(project.projectPath)}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'PRIVATE-TOKEN': await this.token(), accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    requireCondition(response.ok, 'GITLAB_UNAVAILABLE', `GitLab returned HTTP ${response.status}; writes may require reconciliation`)
    const text = await response.text()
    requireCondition(Buffer.byteLength(text) < 8_000_000, 'GITLAB_UNAVAILABLE', 'GitLab response exceeds the safety limit')
    return { data: JSON.parse(text), nextPage: response.headers.get('x-next-page') }
  }
  private async projectId(project: GitLabProject): Promise<number> {
    const record = z.object({ id: positiveId, path_with_namespace: z.string(), web_url: z.string() }).parse((await this.request(project)).data)
    requireCondition(record.path_with_namespace === project.projectPath && record.web_url === `${project.url}/${project.projectPath}`, 'FORBIDDEN', 'GitLab project identity changed; inspect the registered repository')
    return record.id
  }
  private record(raw: unknown, project: GitLabProject, projectId: number, expectedIid?: number): MergeRequestRecord {
    const record = mergeRequestSchema.parse(raw)
    requireCondition(record.project_id === projectId && (expectedIid === undefined || record.iid === expectedIid), 'FORBIDDEN', 'GitLab returned a different project or MR')
    validateMergeRequest(record, project, record.source_branch, record.target_branch)
    return record
  }
  private async pages(project: GitLabProject, suffix: string): Promise<unknown[]> {
    const result: unknown[] = []
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(project, `${suffix}${suffix.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      requireCondition(Array.isArray(response.data), 'GITLAB_UNAVAILABLE', 'Unexpected GitLab pagination response')
      result.push(...response.data)
      if (response.nextPage === '' || (response.nextPage === null && response.data.length < 100)) return result
      requireCondition(response.nextPage === null || response.nextPage === String(page + 1), 'GITLAB_UNAVAILABLE', 'Unexpected GitLab next page; observation will not advance')
    }
    throw new Error('GitLab pagination safety budget reached; no observation cursor was advanced')
  }
  async find(project: GitLabProject, branch: string): Promise<MergeRequestRecord[]> {
    const projectId = await this.projectId(project)
    const rows = await this.pages(project, `/merge_requests?scope=all&state=all&source_branch=${encodeURIComponent(branch)}`)
    return rows.map(row => this.record(row, project, projectId))
  }
  async create(project: GitLabProject, input: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<MergeRequestRecord> {
    const projectId = await this.projectId(project)
    const response = await this.request(project, '/merge_requests', { source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.title, description: input.description, remove_source_branch: false })
    const record = this.record(response.data, project, projectId)
    validateMergeRequest(record, project, input.sourceBranch, input.targetBranch)
    return record
  }
  async read(project: GitLabProject, iid: number): Promise<MergeRequestRecord> {
    positiveId.parse(iid)
    const projectId = await this.projectId(project)
    return this.record((await this.request(project, `/merge_requests/${iid}`)).data, project, projectId, iid)
  }
  async feedback(project: GitLabProject, iid: number, headSha: string): Promise<Feedback[]> {
    positiveId.parse(iid)
    sha.parse(headSha)
    await this.projectId(project)
    const [notes, discussions, mergePipelines, commitPipelines] = await Promise.all([
      this.pages(project, `/merge_requests/${iid}/notes?sort=asc&order_by=updated_at`),
      this.pages(project, `/merge_requests/${iid}/discussions`),
      this.pages(project, `/merge_requests/${iid}/pipelines`),
      this.pages(project, `/pipelines?sha=${headSha}`),
    ])
    const noteSchema = z.object({ id: positiveId, body: z.string(), updated_at: z.string(), system: z.boolean().optional(), resolved: z.boolean().optional(), author: z.object({ id: positiveId, username: z.string() }).nullable().optional() })
    const discussionSchema = z.object({ notes: z.array(noteSchema) })
    const pipelineSchema = z.object({ id: positiveId, sha, status: z.string(), updated_at: z.string().optional(), source: z.string().optional() })
    const prefix = `${project.url}/${project.projectPath}:mr:${iid}`
    const feedback = new Map<string, Feedback>()
    const uniqueNotes = new Map<number, z.infer<typeof noteSchema>>()
    for (const raw of [...notes, ...discussions.flatMap(row => discussionSchema.parse(row).notes)]) {
      const note = noteSchema.parse(raw)
      uniqueNotes.set(note.id, { ...uniqueNotes.get(note.id), ...note })
    }
    for (const note of uniqueNotes.values()) {
      const key = `${prefix}:note:${note.id}:${note.updated_at}:${note.resolved ?? ''}`
      feedback.set(key, { key, text: JSON.stringify({ trust: 'untrusted-external-data', source: 'gitlab', kind: note.system ? 'system-note' : 'note', id: note.id, actor: note.author?.username ?? '', body: note.body.slice(0, 20_000), resolved: note.resolved }) })
    }
    const uniquePipelines = new Map<number, z.infer<typeof pipelineSchema>>()
    for (const raw of [...mergePipelines, ...commitPipelines]) {
      const pipeline = pipelineSchema.parse(raw)
      uniquePipelines.set(pipeline.id, { ...uniquePipelines.get(pipeline.id), ...pipeline })
    }
    for (const pipeline of uniquePipelines.values()) {
      const key = `${prefix}:pipeline:${pipeline.id}:${pipeline.sha}:${pipeline.status}:${pipeline.updated_at ?? ''}`
      feedback.set(key, { key, text: JSON.stringify({ trust: 'untrusted-external-data', source: 'gitlab', kind: 'pipeline', id: pipeline.id, sha: pipeline.sha, observedHeadSha: headSha, status: pipeline.status, pipelineSource: pipeline.source }) })
    }
    return [...feedback.values()]
  }
}
