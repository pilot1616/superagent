import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { invoke } from './ipc.js'

const same = (actual: string, expected: string) => Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
export async function startPanel(state: string, port = 0) {
  const loginSecret = randomBytes(32).toString('hex')
  let session = randomBytes(32).toString('hex')
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
    try {
      if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])))) { fail(403, 'Local origin required'); return }
      const url = new URL(request.url ?? '/', origin)
      if (request.method === 'POST' && url.pathname === '/login') {
        if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { fail(403, 'Same-origin JSON login required'); return }
        if (Date.now() - windowStarted > 60_000) { attempts = 0; windowStarted = Date.now() }
        if (++attempts > 10) { fail(429, 'Too many login attempts'); return }
        let body = ''
        request.setEncoding('utf8')
        for await (const chunk of request) { body += chunk; if (body.length > 1024) { fail(413, 'Request too large'); return } }
        const value: unknown = JSON.parse(body).token
        if (typeof value !== 'string' || !same(value, loginSecret)) { fail(401, 'Invalid login token'); return }
        session = randomBytes(32).toString('hex')
        expires = Date.now() + 60 * 60_000
        response.setHeader('set-cookie', `superagent_panel=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`)
        response.end('{}'); return
      }
      if (request.method !== 'GET') { fail(405, 'Panel is read-only; use the trusted CLI for mutations'); return }
      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      if (assets.has(asset)) {
        response.setHeader('content-type', asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.js') ? 'application/javascript' : 'text/css')
        response.end(assets.get(asset)); return
      }
      const cookie = request.headers.cookie?.split(';').map(entry => entry.trim()).find(entry => entry.startsWith('superagent_panel='))?.slice('superagent_panel='.length) ?? ''
      if (Date.now() >= expires || !same(cookie, session)) { fail(401, 'Sign in using the token shown in your trusted terminal'); return }
      let method: string
      let params: unknown = {}
      if (url.pathname === '/api/health') method = 'health'
      else if (url.pathname === '/api/tasks') { method = 'task_list'; params = { cursor: Number(url.searchParams.get('cursor') ?? 0), limit: 50 } }
      else if (/^\/api\/tasks\/[a-f0-9-]{36}$/.test(url.pathname)) { method = 'task_get'; params = { ticketId: url.pathname.split('/').at(-1), cursor: Number(url.searchParams.get('cursor') ?? 0) } }
      else { fail(404, 'Read endpoint not found'); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(await invoke(state, 'bridge', method, params)))
    } catch { fail(503, 'Unable to read the local task service') }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback listener')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, loginSecret, server, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
