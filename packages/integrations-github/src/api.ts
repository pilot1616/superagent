import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { requireCondition, type Pull } from '../../core/src/model.js'

export interface PullRecord { number: number; html_url: string; state: string; merged_at: string | null; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { full_name: string } } }
export interface Feedback { key: string; text: string }
export interface GitHubPort {
  find(repository: string, branch: string): Promise<PullRecord[]>
  create(repository: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRecord>
  read(repository: string, number: number): Promise<PullRecord>
  feedback(repository: string, number: number, sha: string): Promise<Feedback[]>
}
export function validatePull(record: PullRecord, repository: string, branch: string, baseRef: string): Pull {
  requireCondition(record.head.repo?.full_name.toLowerCase() === repository.toLowerCase() && record.base.repo.full_name.toLowerCase() === repository.toLowerCase() && record.head.ref === branch && record.base.ref === baseRef, 'FORBIDDEN', 'PR repository, branch or base does not match the registered task')
  requireCondition(Number.isSafeInteger(record.number) && record.number > 0 && /^[a-f0-9]{40,64}$/.test(record.head.sha), 'FORBIDDEN', 'Invalid PR identity')
  requireCondition(record.html_url === `https://github.com/${repository}/pull/${record.number}`, 'FORBIDDEN', 'Unexpected PR URL')
  return { number: record.number, url: record.html_url, headSha: record.head.sha, branch, state: record.merged_at ? 'merged' : record.state === 'open' ? 'open' : 'closed' }
}
export class GitHubHttp implements GitHubPort {
  constructor(private state: string) {}
  async token(): Promise<string> {
    const info = await lstat(join(this.state, 'github.token'))
    requireCondition(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'GitHub credential must be an owner-only regular file')
    const token = (await readFile(join(this.state, 'github.token'), 'utf8')).trim()
    requireCondition(token.length > 10 && !/[\s\r\n]/.test(token), 'RUNTIME_UNAVAILABLE', 'Configure a restricted GitHub token in the private service state directory')
    return token
  }
  private async request<Result>(path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`https://api.github.com/repos/${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    requireCondition(response.ok, 'GITHUB_UNAVAILABLE', `GitHub returned HTTP ${response.status}; writes may require reconciliation`)
    const text = await response.text()
    requireCondition(Buffer.byteLength(text) < 8_000_000, 'GITHUB_UNAVAILABLE', 'GitHub response exceeds the safety limit')
    return JSON.parse(text) as Result
  }
  private async pages(path: string, key?: string): Promise<any[]> {
    const result: any[] = []
    for (let page = 1; page <= 100; page++) {
      const response = await this.request<any>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const rows = key ? response[key] : response
      requireCondition(Array.isArray(rows), 'GITHUB_UNAVAILABLE', 'Unexpected GitHub pagination response')
      result.push(...rows)
      if (rows.length < 100) return result
    }
    throw new Error('GitHub pagination safety budget reached; no observation cursor was advanced')
  }
  find(repository: string, branch: string): Promise<PullRecord[]> { return this.pages(`${repository}/pulls?state=all&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}`) }
  create(repository: string, input: { head: string; base: string; title: string; body: string }): Promise<PullRecord> { return this.request(`${repository}/pulls`, input) }
  read(repository: string, number: number): Promise<PullRecord> { return this.request(`${repository}/pulls/${number}`) }
  async feedback(repository: string, number: number, sha: string): Promise<Feedback[]> {
    const groups = await Promise.all([
      this.pages(`${repository}/issues/${number}/comments`),
      this.pages(`${repository}/pulls/${number}/reviews`),
      this.pages(`${repository}/pulls/${number}/comments`),
      this.pages(`${repository}/commits/${sha}/check-runs`, 'check_runs'),
      this.pages(`${repository}/commits/${sha}/statuses`),
    ])
    return groups.flatMap((rows, category) => rows.map(row => ({
      key: `${repository}:${number}:${category}:${row.id}:${row.updated_at ?? row.completed_at ?? row.submitted_at ?? row.created_at ?? ''}:${row.status ?? ''}:${row.conclusion ?? row.state ?? ''}`,
      text: JSON.stringify({ trust: 'untrusted-external-data', source: ['comment', 'review', 'inline-review', 'check', 'status'][category], author: row.user?.login ?? row.creator?.login ?? row.app?.slug ?? 'unknown', actorType: row.user?.type ?? row.creator?.type ?? 'integration', body: String(row.body ?? row.output?.summary ?? row.description ?? '').slice(0, 20_000), state: row.conclusion ?? row.state ?? row.status, name: row.name ?? row.context }),
    })))
  }
}
