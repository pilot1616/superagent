import { createHash, randomUUID } from 'node:crypto'
import { realpath, writeFile, rename, rm, mkdir, readFile, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { requireCondition } from '../../core/src/model.js'

export async function writePanelToken(state: string, destination: string, token: string): Promise<void> {
  const root = await realpath(state)
  requireCondition(resolve(destination) === join(root, 'panel-login.token'), 'FORBIDDEN', 'Panel token file must be STATE/panel-login.token')
  const temporary = join(root, `.panel-login-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, token, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}

export async function acquirePanel(state: string) {
  const root = await realpath(state)
  const info = await lstat(root)
  requireCondition(info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Panel requires private owned state')
  const lock = join(root, 'panel.lock')
  try { await mkdir(lock, { mode: 0o700 }) }
  catch { requireCondition(false, 'PANEL_ALREADY_RUNNING', 'This state already owns a panel; reuse it, or inspect the previous owner before recovering panel.lock') }
  const instanceId = randomUUID()
  try { await writeFile(join(lock, 'owner.json'), JSON.stringify({ instanceId, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }) }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error }
  return {
    instanceId,
    async publish(origin: string, token: string) {
      await writePanelToken(root, join(root, 'panel-login.token'), token)
      const temporary = join(root, `.panel-session-${instanceId}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify({ instanceId, pid: process.pid, origin, published: true, tokenHash: createHash('sha256').update(token).digest('hex') }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(root, 'panel-session.json'))
      } finally { await rm(temporary, { force: true }) }
    },
    async release() {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
      if (owner.instanceId !== instanceId) return
      const published = await readFile(join(root, 'panel-session.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      if (published?.instanceId === instanceId) {
        await rm(join(root, 'panel-session.json'), { force: true })
        await rm(join(root, 'panel-login.token'), { force: true })
      }
      await rm(lock, { recursive: true })
    },
  }
}

export async function recoverPanel(state: string) {
  const root = await realpath(state)
  const info = await lstat(root)
  requireCondition(info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), 'FORBIDDEN', 'Panel recovery requires private owned state')
  const lock = join(root, 'panel.lock')
  const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))
  requireCondition(Number.isSafeInteger(owner.pid) && owner.pid > 1 && typeof owner.instanceId === 'string', 'FORBIDDEN', 'Invalid panel owner; inspect manually')
  let absent = false
  try { process.kill(owner.pid, 0) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH' }
  requireCondition(absent, 'RECONCILIATION_REQUIRED', 'Panel owner is alive or PID was reused; refusing to remove its lock')
  const session = await readFile(join(root, 'panel-session.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
  if (session?.instanceId === owner.instanceId) {
    await rm(join(root, 'panel-session.json'), { force: true })
    await rm(join(root, 'panel-login.token'), { force: true })
  }
  await rm(lock, { recursive: true })
}
