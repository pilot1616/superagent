import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DomainError } from '../../core/src/model.js'

export interface ProcessIdentity { pid: number; parent: number; group: number; start: string }
export function createProcessObserver(command: string, args: string[], timeoutMs = 3000) {
  let pending: Promise<Map<number, ProcessIdentity>> | undefined
  return () => pending ??= new Promise<Map<number, ProcessIdentity>>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } })
    let output = ''
    let bytes = 0
    const failure = () => new DomainError('PROCESS_OBSERVATION_FAILED', 'Host process observation failed or timed out; rebuild the native observer on macOS and keep execution quarantined', 503)
    const stop = () => {
      clearTimeout(deadline)
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.unref()
      reject(failure())
    }
    const deadline = setTimeout(stop, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 4_000_000) stop()
      else output += chunk
    })
    child.on('error', () => { clearTimeout(deadline); reject(failure()) })
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      pending = undefined
      if (code !== 0 || signal) { reject(failure()); return }
      const snapshot = new Map<number, ProcessIdentity>()
      for (const line of output.trim().split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) { reject(failure()); return }
        const identity = { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), start: match[4]! }
        if (![identity.pid, identity.parent, identity.group].every(Number.isSafeInteger) || identity.pid === 0 || snapshot.has(identity.pid)) { reject(failure()); return }
        snapshot.set(identity.pid, identity)
      }
      resolve(snapshot)
    })
  })
}
export const processSnapshot = process.platform === 'darwin'
  ? createProcessObserver(fileURLToPath(new URL('./process-snapshot-darwin.bin', import.meta.url)), [])
  : createProcessObserver('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='])
export class ProcessTracker {
  readonly observed = new Map<number, ProcessIdentity>()
  private failed = false
  private sampling?: Promise<Map<number, ProcessIdentity> | undefined>
  constructor(readonly pid: number, private observe = processSnapshot) { void this.sample() }
  sample(): Promise<Map<number, ProcessIdentity> | undefined> {
    return this.sampling ??= this.collect().finally(() => { this.sampling = undefined })
  }
  private async collect() {
    try {
      const snapshot = await this.observe()
      const leader = snapshot.get(this.pid)
      if (leader?.start === 'unavailable' || [...this.observed.keys()].some(pid => snapshot.get(pid)?.start === 'unavailable')) throw new Error('Owned process identity is inaccessible')
      if (!this.observed.has(this.pid) && leader) this.observed.set(this.pid, leader)
      let changed = true
      while (changed) {
        changed = false
        for (const identity of snapshot.values()) {
          const parent = this.observed.get(identity.parent)
          const liveParent = snapshot.get(identity.parent)
          if (identity.pid !== this.pid && parent && parent.start === liveParent?.start && this.observed.get(identity.pid)?.start !== identity.start) {
            if (identity.start === 'unavailable') throw new Error('Descendant process identity is inaccessible')
            this.observed.set(identity.pid, identity); changed = true
          }
        }
      }
      return snapshot
    } catch { this.failed = true; return undefined }
  }
  async assertOwnedGroup() {
    let snapshot = await this.sample()
    if (snapshot && !this.failed && !this.observed.has(this.pid)) snapshot = await this.sample()
    if (!snapshot || this.failed) throw new DomainError('PROCESS_OBSERVATION_FAILED', 'Process identity cannot be verified; keep execution quarantined', 503)
    const leader = snapshot.get(this.pid)
    const original = this.observed.get(this.pid)
    if (leader && original && leader.start !== original.start) throw new Error('Process group leader PID was reused; refusing to signal it')
    if (!original) throw new DomainError('PROCESS_OBSERVATION_FAILED', 'Original process group identity was not captured; refusing to signal it', 503)
  }
  async groupAbsent(): Promise<boolean> {
    const snapshot = await this.sample()
    if (!snapshot || this.failed) throw new DomainError('PROCESS_OBSERVATION_FAILED', 'Process group absence cannot be verified; cleanup remains uncertain', 503)
    return ![...snapshot.values()].some(identity => identity.group === this.pid)
  }
  async assertNoObservedEscape() {
    const snapshot = await this.sample()
    if (!snapshot || this.failed) throw new DomainError('PROCESS_OBSERVATION_FAILED', 'Descendant observation failed; cleanup remains uncertain', 503)
    for (const [pid, observed] of this.observed) {
      const current = snapshot.get(pid)
      if (pid !== this.pid && current?.start === observed.start) throw new Error('An observed descendant escaped or survived the owned process group; manual reconciliation required')
    }
  }
}
