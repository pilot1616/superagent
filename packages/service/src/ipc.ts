import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Envelope { ok: boolean; data?: unknown; error?: { code: string; message: string }; operationId: string }
export async function invoke(state: string, role: 'bridge' | 'admin', method: string, params: unknown = {}): Promise<Envelope> {
  const token = (await readFile(join(state, `${role}.token`), 'utf8')).trim()
  const payload = JSON.stringify({ method, params })
  return new Promise((resolve, reject) => {
    const timeout = ['plan_workspace_preview', 'plan-workspace-configure', 'task_workspace_prepare'].includes(method) ? 120_000 : 15_000
    const connection = request({ socketPath: join(state, 'service.sock'), path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk; if (Buffer.byteLength(data) > 8_000_000) connection.destroy(new Error('Service response too large')) })
      response.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid service response')) } })
      response.on('error', reject)
    })
    connection.on('timeout', () => connection.destroy(new Error('Service request timed out; query task state before repeating a mutation')))
    connection.on('error', reject)
    connection.end(payload)
  })
}
