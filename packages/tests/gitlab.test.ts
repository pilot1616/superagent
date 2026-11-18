import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, writeFile, chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseGitLabRemote } from '../core/src/gitlab.js'
import { DomainError, type GitLabProject, type PublishPreview, type Ticket } from '../core/src/model.js'
import { GitLabHttp, validateMergeRequest, type MergeRequestRecord } from '../integrations-gitlab/src/api.js'
import { initialize, readConfig } from '../service/src/config.js'
import { git } from '../service/src/workspace.js'
import { startService } from '../service/src/daemon.js'
import { Store } from '../storage/src/store.js'
import { pushCommit } from '../integrations-gitlab/src/workspace.js'

const project: GitLabProject = { url: 'https://gitlab.example.test:8443', projectPath: 'group/subgroup/project' }
const projectRecord = { id: 42, path_with_namespace: project.projectPath, web_url: `${project.url}/${project.projectPath}` }
const record: MergeRequestRecord = { iid: 7, project_id: 42, source_project_id: 42, target_project_id: 42, source_branch: 'superagent/task', target_branch: 'main', sha: 'a'.repeat(40), state: 'opened', web_url: `${project.url}/${project.projectPath}/-/merge_requests/7` }
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
const suffix = (url: URL) => url.pathname.replace('/api/v4/projects/group%2Fsubgroup%2Fproject', '')

async function client(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sa-gitlab-api-')))
  const credential = 'fixture-token-never-valid-outside-tests'
  await writeFile(join(directory, 'gitlab.token'), credential, { mode: 0o600 })
  const requests: { url: URL; init: RequestInit }[] = []
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    requests.push({ url, init })
    assert.equal(url.origin, project.url)
    assert.equal(new Headers(init.headers).get('private-token'), credential)
    assert.equal(init.redirect, 'error')
    assert.equal(url.searchParams.has('private_token'), false)
    return handler(url, init)
  }
  return { api: new GitLabHttp(directory, project, transport), directory, requests, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('GitLab remotes support nested groups and explicit self-managed HTTPS and SSH hosts', () => {
  assert.deepEqual(parseGitLabRemote('https://gitlab.com/group/sub/project.git'), { url: 'https://gitlab.com', projectPath: 'group/sub/project' })
  assert.deepEqual(parseGitLabRemote('git@gitlab.com:group/project.git'), { url: 'https://gitlab.com', projectPath: 'group/project' })
  assert.deepEqual(parseGitLabRemote('git@git.in.chaitin.net:group/sub/project.git', 'https://git.in.chaitin.net'), { url: 'https://git.in.chaitin.net', projectPath: 'group/sub/project' })
  assert.deepEqual(parseGitLabRemote('ssh://git@gitlab.example.test:2222/group/subgroup/project.git', project.url), project)
  assert.deepEqual(parseGitLabRemote('git@gitlab.example.test:group/subgroup/project.git', project.url), project)
  assert.deepEqual(parseGitLabRemote(`${project.url}/${project.projectPath}.git`, project.url), project)
  assert.equal(parseGitLabRemote(''), undefined)
})

test('GitLab registration rejects mismatched hosts, credentials, traversal and unsafe instance URLs', () => {
  for (const remote of ['https://github.com/group/project.git', 'https://user:token@gitlab.com/group/project.git', 'https://gitlab.com/group/../project', 'https://gitlab.com/group/%2e%2e/project', 'https://gitlab.com/group/project?redirect=1', 'git@gitlab.com:group/project.git/../secret', 'https://gitlab.com.evil.test/group/project.git']) assert.throws(() => parseGitLabRemote(remote))
  for (const url of ['http://gitlab.example.test', 'https://user:secret@gitlab.example.test', 'https://gitlab.example.test/gitlab', 'https://gitlab.example.test?token=secret', 'https://github.com']) assert.throws(() => parseGitLabRemote('', url))
  assert.throws(() => parseGitLabRemote('git@gitlab.example.test:group/project.git'), /configured GitLab host/)
})

test('GitLab MR validation uses IID, exact project and host, rejects forks and distinguishes locked from closed', () => {
  const bound = validateMergeRequest(record, project, record.source_branch, 'main')
  assert.equal(bound.iid, 7)
  for (const state of ['opened', 'locked'] as const) assert.equal(validateMergeRequest({ ...record, state }, project, record.source_branch, 'main').state, 'open')
  for (const state of ['merged', 'closed'] as const) assert.equal(validateMergeRequest({ ...record, state }, project, record.source_branch, 'main').state, state)
  for (const changed of [{ ...record, source_project_id: 99 }, { ...record, target_branch: 'other' }, { ...record, web_url: record.web_url.replace(project.url, 'https://evil.test') }, { ...record, iid: 0 }, { ...record, sha: '' }]) assert.throws(() => validateMergeRequest(changed, project, record.source_branch, 'main'))
})

test('GitLab REST adapter encodes subgroup paths, paginates MR lookup and uses native create/read fields', async () => {
  const context = await client((url, init) => {
    if (suffix(url) === '') return json(projectRecord)
    if (suffix(url) === '/merge_requests' && init.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { source_branch: record.source_branch, target_branch: 'main', title: 'Fixture', description: 'Approved description', remove_source_branch: false })
      return json(record)
    }
    if (suffix(url) === '/merge_requests/7') return json(record)
    assert.equal(suffix(url), '/merge_requests')
    assert.equal(url.searchParams.get('state'), 'all')
    assert.equal(url.searchParams.get('source_branch'), record.source_branch)
    return url.searchParams.get('page') === '1' ? json([record], { 'x-next-page': '2' }) : json([], { 'x-next-page': '' })
  })
  try {
    assert.deepEqual(await context.api.find(project, record.source_branch), [record])
    assert.equal((await context.api.read(project, 7)).iid, 7)
    assert.equal((await context.api.create(project, { sourceBranch: record.source_branch, targetBranch: 'main', title: 'Fixture', description: 'Approved description' })).iid, 7)
    assert.equal(context.requests.filter(request => request.init.method === 'POST').length, 1)
    assert.ok(context.requests.every(request => request.url.pathname.startsWith('/api/v4/projects/group%2Fsubgroup%2Fproject')))
  } finally { await context.cleanup() }
})

test('GitLab credentials never follow host changes or redirects and HTTP errors do not replay writes', async () => {
  const context = await client(url => suffix(url) === '' ? json(projectRecord) : new Response('secret response body', { status: 302, headers: { location: 'https://evil.test/' } }))
  try {
    await assert.rejects(context.api.find({ ...project, url: 'https://evil.test' }, 'branch'), /registered host/)
    assert.equal(context.requests.length, 0)
    await assert.rejects(context.api.create(project, { sourceBranch: record.source_branch, targetBranch: 'main', title: 'Test', description: 'Test' }), error => error instanceof DomainError && /HTTP 302/.test(error.message) && !error.message.includes('secret'))
    assert.equal(context.requests.filter(request => request.init.method === 'POST').length, 1)
    await chmod(join(context.directory, 'gitlab.token'), 0o644)
    await assert.rejects(context.api.read(project, 7), /owner-only/)
  } finally { await context.cleanup() }
})

test('GitLab adapter rejects mismatched project IDs and MR IIDs', async () => {
  const context = await client(url => suffix(url) === '' ? json(projectRecord) : json({ ...record, project_id: 99, source_project_id: 99, target_project_id: 99 }))
  try { await assert.rejects(context.api.read(project, 7), /different project or MR/) } finally { await context.cleanup() }
  const wrongIid = await client(url => suffix(url) === '' ? json(projectRecord) : json(record))
  try { await assert.rejects(wrongIid.api.read(project, 8), /different project or MR/) } finally { await wrongIid.cleanup() }
})

test('GitLab feedback deduplicates notes and discussions, observes pipeline status changes without approving', async () => {
  let status = 'running'
  let resolved = false
  const note = { id: 10, body: 'Please inspect this change', updated_at: '2026-11-17T01:00:00Z', system: false, author: { id: 1, username: 'reviewer' } }
  const context = await client(url => {
    const path = suffix(url)
    if (path === '') return json(projectRecord)
    if (path.endsWith('/notes')) return json([note, { ...note, id: 11, system: true, body: 'approved this merge request' }])
    if (path.endsWith('/discussions')) return json([{ id: 'discussion', notes: [note, { ...note, id: 12, resolved }] }])
    if (path.endsWith('/pipelines')) return json([{ id: 20, sha: record.sha, status, ...(path === '/pipelines' ? { updated_at: '2026-11-17T01:00:00Z' } : {}) }])
    throw new Error('Unexpected GitLab route')
  })
  try {
    const first = await context.api.feedback(project, 7, record.sha)
    assert.equal(first.length, 4)
    assert.deepEqual(await context.api.feedback(project, 7, record.sha), first)
    assert.ok(first.every(entry => JSON.parse(entry.text).trust === 'untrusted-external-data'))
    status = 'failed'
    resolved = true
    const next = await context.api.feedback(project, 7, record.sha)
    assert.equal(next.length, 4)
    assert.notEqual(next[2]!.key, first[2]!.key)
    assert.notEqual(next.at(-1)!.key, first.at(-1)!.key)
    assert.ok(context.requests.every(request => request.init.method === 'GET'))
    assert.ok(context.requests.some(request => request.url.searchParams.get('sha') === record.sha))
  } finally { await context.cleanup() }
})

test('GitLab pagination failures abort the entire observation instead of returning partial feedback', async () => {
  const context = await client(url => suffix(url) === '' ? json(projectRecord) : json([], { 'x-next-page': 'https://evil.test/next' }))
  try { await assert.rejects(context.api.feedback(project, 7, record.sha), /Unexpected GitLab next page/) } finally { await context.cleanup() }
})

test('GitLab push targets only the approved HTTPS project with credentials outside argv and redirects disabled', async () => {
  const preview = { provider: 'gitlab', repository: project, branch: record.source_branch } as PublishPreview
  let calls = 0
  await pushCommit({ workspace: '/fixture-workspace' } as Ticket, preview, record.sha, 'fixture-token', async (directory, args, env) => {
    calls++
    assert.equal(directory, '/fixture-workspace')
    assert.deepEqual(args, ['push', '--porcelain', `${project.url}/${project.projectPath}.git`, `${record.sha}:refs/heads/${record.source_branch}`])
    assert.equal(args.some(value => value.includes('fixture-token') || value.includes('--force')), false)
    assert.equal(env?.GIT_CONFIG_KEY_0, `http.${project.url}/${project.projectPath}.git.extraheader`)
    assert.equal(env?.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('oauth2:fixture-token').toString('base64')}`)
    assert.equal(env?.GIT_CONFIG_KEY_1, 'http.followRedirects')
    assert.equal(env?.GIT_CONFIG_VALUE_1, 'false')
    return ''
  })
  assert.equal(calls, 1)
})

test('self-managed initialization writes version three with delivery disabled and refuses legacy configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sa-gl-state-')))
  const state = join(root, 'state')
  const repository = join(root, 'repo')
  try {
    await git(root, ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'README'), 'local fixture\n')
    await git(repository, ['add', 'README'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base'])
    await git(repository, ['remote', 'add', 'origin', 'git@gitlab.example.test:group/subgroup/project.git'])
    await initialize(state, repository, join(root, 'worktrees'), 'fixture-model', 'main', 'https://gitlab.example.test')
    const config = await readConfig(state)
    assert.equal(config.version, 3)
    assert.equal(config.gitlabEnabled, false)
    const store = new Store(join(state, 'tasks.sqlite'))
    try { assert.deepEqual(store.repository()!.gitlab, { ...project, url: 'https://gitlab.example.test' }) } finally { store.close() }
    const service = await startService(state)
    await service.close()
    const legacy = new Store(join(state, 'tasks.sqlite'))
    try { legacy.set('repository', { ...legacy.repository()!, github: 'legacy/project' }) } finally { legacy.close() }
    await assert.rejects(startService(state), error => error instanceof DomainError && error.code === 'MIGRATION_REQUIRED')
    await writeFile(join(state, 'service.json'), JSON.stringify({ version: 1, operatorId: 'human', concurrency: 1, githubEnabled: true }))
    await assert.rejects(readConfig(state), error => error instanceof DomainError && error.code === 'MIGRATION_REQUIRED')
    assert.equal(JSON.parse(await readFile(join(state, 'service.json'), 'utf8')).version, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
