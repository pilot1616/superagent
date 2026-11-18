import { execFileSync } from 'node:child_process'

export interface ProcessIdentity { pid: number; parent: number; group: number; start: string }
export function processSnapshot(): Map<number, ProcessIdentity> {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 3000, maxBuffer: 4_000_000 })
  return new Map(output.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) throw new Error('Process identity observation failed')
    const identity = { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), start: match[4]! }
    return [identity.pid, identity]
  }))
}
export class ProcessTracker {
  readonly observed = new Map<number, ProcessIdentity>()
  private failed = false
  constructor(readonly pid: number) { this.sample() }
  sample() {
    try {
      const snapshot = processSnapshot()
      const leader = snapshot.get(this.pid)
      if (!this.observed.has(this.pid) && leader) this.observed.set(this.pid, leader)
      let changed = true
      while (changed) {
        changed = false
        for (const identity of snapshot.values()) {
          const parent = this.observed.get(identity.parent)
          const liveParent = snapshot.get(identity.parent)
          if (identity.pid !== this.pid && parent && parent.start === liveParent?.start && this.observed.get(identity.pid)?.start !== identity.start) { this.observed.set(identity.pid, identity); changed = true }
        }
      }
      return snapshot
    } catch { this.failed = true; return undefined }
  }
  assertOwnedGroup() {
    const snapshot = this.sample()
    if (!snapshot || this.failed) throw new Error('Process identity cannot be verified; keep execution quarantined')
    const leader = snapshot.get(this.pid)
    const original = this.observed.get(this.pid)
    if (leader && original && leader.start !== original.start) throw new Error('Process group leader PID was reused; refusing to signal it')
    if ([...snapshot.values()].some(identity => identity.group === this.pid) && !original) throw new Error('Original process group identity was not captured; refusing to signal it')
  }
  groupAbsent(): boolean {
    const snapshot = this.sample()
    if (!snapshot || this.failed) throw new Error('Process group absence cannot be verified; cleanup remains uncertain')
    return ![...snapshot.values()].some(identity => identity.group === this.pid)
  }
  assertNoObservedEscape() {
    const snapshot = this.sample()
    if (!snapshot || this.failed) throw new Error('Descendant observation failed; cleanup remains uncertain')
    for (const [pid, observed] of this.observed) {
      const current = snapshot.get(pid)
      if (pid !== this.pid && current?.start === observed.start) throw new Error('An observed descendant escaped or survived the owned process group; manual reconciliation required')
    }
  }
}
