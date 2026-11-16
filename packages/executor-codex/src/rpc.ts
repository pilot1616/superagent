import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export interface RpcMessage {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export class AppServer extends EventEmitter {
  readonly epoch = randomUUID()
  readonly child: ChildProcessWithoutNullStreams
  private sequence = 0
  private buffer = ''
  private closed = false
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    super()
    this.child = spawn(command, args, { ...options, stdio: 'pipe', detached: process.platform !== 'win32' })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => this.emit('diagnostic', chunk.slice(0, 4000)))
    this.child.on('error', error => this.disconnect(error))
    this.child.on('exit', () => this.disconnect(new Error('App Server disconnected; reconcile uncertain operations before retrying')))
    this.child.stdin.on('error', error => this.disconnect(error))
  }
  private receive(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 8_000_000) { this.disconnect(new Error('App Server frame limit exceeded')); return }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: RpcMessage
      try { message = JSON.parse(line) as RpcMessage } catch { this.disconnect(new Error('Invalid App Server JSON')); return }
      if (!message || typeof message !== 'object' || Array.isArray(message) || (message.method !== undefined && typeof message.method !== 'string')) { this.disconnect(new Error('Invalid App Server envelope')); return }
      if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message)
      else if (typeof message.id === 'number') {
        const deferred = this.pending.get(message.id)
        if (!deferred) continue
        clearTimeout(deferred.timer)
        this.pending.delete(message.id)
        if (message.error) deferred.reject(new Error(`App Server RPC error ${message.error.code}; inspect the local runtime without replaying uncertain work`))
        else deferred.resolve(message.result)
      }
    }
  }
  request<Result = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('App Server is closed'))
    const id = ++this.sequence
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; outcome unknown`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }
  send(message: RpcMessage): void {
    if (this.closed) throw new Error('App Server is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  async initialize(): Promise<unknown> {
    const result = await this.request('initialize', { clientInfo: { name: 'codex-superagent', version: '0.1.0' }, capabilities: { experimentalApi: false } })
    this.send({ method: 'initialized', params: {} })
    return result
  }
  private disconnect(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const deferred of this.pending.values()) { clearTimeout(deferred.timer); deferred.reject(error) }
    this.pending.clear()
    this.emit('disconnected', error)
    void this.close().catch(() => undefined)
  }
  async close(): Promise<void> {
    if (!this.child.pid) return
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
        else this.child.kill(signal)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    terminate('SIGTERM')
    const timer = setTimeout(() => terminate('SIGKILL'), 3_000)
    await exited.finally(() => clearTimeout(timer))
  }
}
