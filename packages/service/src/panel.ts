import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { invoke } from './ipc.js'
import { panelActions, panelError } from './panel-actions.js'
import { acquirePanel } from './panel-token.js'

const same = (actual: string, expected: string) => Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
export async function startPanel(state: string, port = 0) {
  const loginSecret = randomBytes(32).toString('hex')
  const cookieName = `superagent_panel_${randomBytes(12).toString('hex')}`
  let session = randomBytes(32).toString('hex')
  let csrf = randomBytes(32).toString('hex')
  const actions = panelActions(state)
  let expires = 0
  let attempts = 0
  let windowStarted = Date.now()
  const assets = new Map(await Promise.all(['index.html', 'panel.js', 'panel.css'].map(async name => [name, await readFile(new URL(`../../panel/${name}`, import.meta.url))] as const)))
  let origin = ''
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    const fail = (status: number, error: string) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error })) }
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)) }
    const body = async (limit = 65_536) => {
      let text = ''
      request.setEncoding('utf8')
      for await (const chunk of request) {
        text += chunk
        if (Buffer.byteLength(text) > limit) { fail(413, 'Request too large'); return undefined }
      }
      return JSON.parse(text)
    }
    try {
      if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) { fail(403, 'Local origin required'); return }
      const url = new URL(request.url ?? '/', origin)
      if (request.method === 'POST' && url.pathname === '/login') {
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { fail(403, 'Same-origin JSON login required'); return }
        if (Date.now() - windowStarted > 60_000) { attempts = 0; windowStarted = Date.now() }
        if (++attempts > 10) { fail(429, 'Too many login attempts'); return }
        const input = await body(1024)
        if (input === undefined) return
        const value: unknown = input?.token
        if (typeof value !== 'string' || !same(value.trim(), loginSecret)) { fail(401, 'Invalid login token'); return }
        session = randomBytes(32).toString('hex')
        csrf = randomBytes(32).toString('hex')
        await actions.clear()
        expires = Date.now() + 60 * 60_000
        response.setHeader('set-cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`)
        response.end('{}'); return
      }
      if (!['GET', 'POST'].includes(request.method ?? '')) { fail(405, 'Method not allowed'); return }
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (request.method === 'GET' && assets.has(asset)) {
        response.setHeader('content-type', asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.js') ? 'application/javascript' : 'text/css')
        response.end(assets.get(asset)); return
      }
      const cookie = request.headers.cookie?.split(';').map(entry => entry.trim()).find(entry => entry.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ''
      if (Date.now() >= expires || !same(cookie, session)) { fail(401, 'Sign in using the token shown in your trusted terminal'); return }
      if (request.method === 'POST') {
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json' || typeof request.headers['x-superagent-csrf'] !== 'string' || !same(request.headers['x-superagent-csrf'], csrf)) { fail(403, 'Same-origin JSON and session CSRF required'); return }
        const match = url.pathname.match(/^\/api\/approvals\/([a-f0-9-]{36})\/(preview|decide)$/)
        const runtimeRoutes: Record<string, string> = { '/api/runtime/check': 'runtime-check', '/api/runtime/verification/preview': 'runtime-verify-preview', '/api/runtime/verification/start': 'runtime-verify', '/api/runtime/enable/preview': 'runtime-enable-preview', '/api/runtime/enable': 'runtime-enable', '/api/runtime/disable/preview': 'runtime-disable-preview', '/api/runtime/disable': 'runtime-disable', '/api/runtime/reconcile': 'runtime-reconcile' }
        const cancel = url.pathname.match(/^\/api\/runtime\/verification\/([a-f0-9-]{36})\/cancel$/)
        const answer = url.pathname.match(/^\/api\/runtime\/input\/([a-f0-9-]{36})\/answer$/)
        const materials = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/materials\/(preview|attach)$/)
        const workspacePlan = url.pathname.match(/^\/api\/plans\/([a-f0-9-]{36})\/workspace\/(preview|configure)$/)
        const workspaceTask = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/workspace\/prepare$/)
        if (!match && !runtimeRoutes[url.pathname] && !cancel && !answer && !materials && !workspacePlan && !workspaceTask && !['/api/control', '/api/worker-check'].includes(url.pathname)) { fail(405, 'Unknown control endpoint'); return }
        const input = await body()
        if (input === undefined) return
        if (workspacePlan || workspaceTask) {
          const target = workspacePlan ?? workspaceTask!
          if (!input || typeof input !== 'object' || input[workspacePlan ? 'planId' : 'ticketId'] !== target[1]) { fail(400, 'URL target must match workspace operation'); return }
          json(await actions.runtime(workspacePlan ? workspacePlan[2] === 'preview' ? 'plan_workspace_preview' : 'plan-workspace-configure' : 'task_workspace_prepare', input)); return
        }
        if (materials) {
          if (!input || typeof input !== 'object' || input.ticketId !== materials[1]) { fail(400, 'URL task must match the reference target'); return }
          json(await actions.runtime(`task-materials-${materials[2]}`, input)); return
        }
        if (runtimeRoutes[url.pathname]) { json(await actions.runtime(runtimeRoutes[url.pathname]!, input)); return }
        if (cancel || answer) {
          if (!input || typeof input !== 'object' || input.id !== (cancel ?? answer)![1]) { fail(400, 'URL target must match the confirmed request'); return }
          json(await actions.runtime(cancel ? 'runtime-verification-cancel' : 'runtime-answer', input)); return
        }
        const result = match ? match[2] === 'preview' ? { ok: true, data: await actions.preview(match[1]!, input) } : await actions.decide(match[1]!, input) : url.pathname === '/api/worker-check' ? await actions.inspect(input) : await actions.control(input)
        json(result); return
      }
      if (url.pathname === '/api/session') { json({ ok: true, data: { csrf } }); return }
      if (url.pathname === '/api/approvals') { json({ ok: true, data: await actions.pending() }); return }
      if (url.pathname === '/api/runtime') { json(await actions.runtime('runtime-status', {})); return }
      if (/^\/api\/tasks\/[a-f0-9-]{36}\/materials$/.test(url.pathname)) { json(await actions.runtime('task-materials-list', { ticketId: url.pathname.split('/')[3] })); return }
      if (/^\/api\/runtime\/verification\/[a-f0-9-]{36}$/.test(url.pathname)) { json(await actions.runtime('runtime-verification-get', { id: url.pathname.split('/').at(-1) })); return }
      let method: string
      let params: unknown = {}
      if (url.pathname === '/api/health') method = 'health'
      else if (url.pathname === '/api/tasks') { method = 'task_list'; params = { cursor: Number(url.searchParams.get('cursor') ?? 0), limit: Number(url.searchParams.get('limit') ?? 10), view: url.searchParams.get('view') ?? 'active', query: url.searchParams.get('query') ?? '', ...(url.searchParams.has('planId') ? { planId: url.searchParams.get('planId') } : {}) } }
      else if (url.pathname === '/api/plans') { method = 'plan_list'; params = { cursor: Number(url.searchParams.get('cursor') ?? 0), limit: Number(url.searchParams.get('limit') ?? 10) } }
      else if (/^\/api\/plans\/[a-f0-9-]{36}$/.test(url.pathname)) { method = 'plan_get'; params = { planId: url.pathname.split('/').at(-1) } }
      else if (url.pathname === '/api/threads') { method = 'thread_list'; params = { cursor: Number(url.searchParams.get('cursor') ?? 0), limit: Number(url.searchParams.get('limit') ?? 10) } }
      else if (/^\/api\/threads\/[a-zA-Z0-9:-]{1,150}$/.test(url.pathname)) { method = 'thread_get'; params = { threadId: url.pathname.split('/').at(-1), cursor: Number(url.searchParams.get('cursor') ?? 0), limit: 50 } }
      else if (/^\/api\/tasks\/[a-f0-9-]{36}$/.test(url.pathname)) { method = 'task_get'; params = { ticketId: url.pathname.split('/').at(-1), cursor: Number(url.searchParams.get('cursor') ?? 0), checkpointCursor: Number(url.searchParams.get('checkpointCursor') ?? 0) } }
      else { fail(404, 'Read endpoint not found'); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(await invoke(state, 'bridge', method, params)))
    } catch (error) { const result = panelError(error); fail(result.status, result.message) }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  const owner = await acquirePanel(state)
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }) }
  catch (error) { await owner.release(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback listener')
  origin = `http://127.0.0.1:${address.port}`
  try { await owner.publish(origin, loginSecret) }
  catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await owner.release(); throw error }
  let closing: Promise<void> | undefined
  return { origin, loginSecret, server, instanceId: owner.instanceId, close: () => closing ??= new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }).then(() => owner.release()) }
}
