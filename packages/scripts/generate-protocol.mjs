import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '0.154.0-alpha.6.2'
if (execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() !== `codex-cli ${version}`) throw new Error('Only the pinned Codex can regenerate protocol bindings')
const temporary = mkdtempSync(join(tmpdir(), 'sa-protocol-'))
try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', temporary])
  const files = new Map()
  const collect = file => {
    const path = resolve(temporary, file)
    if (files.has(path)) return
    const contents = readFileSync(path, 'utf8')
    files.set(path, contents)
    for (const match of contents.matchAll(/from "([^"]+)"/g)) collect(relative(temporary, resolve(dirname(path), `${match[1]}.ts`)))
  }
  for (const name of ['ThreadStartParams', 'ThreadResumeParams', 'TurnStartParams', 'TurnInterruptParams', 'GetAccountParams', 'GetAccountResponse', 'CommandExecutionRequestApprovalParams', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalParams', 'FileChangeRequestApprovalResponse', 'PermissionsRequestApprovalParams', 'PermissionsRequestApprovalResponse', 'ToolRequestUserInputParams', 'ToolRequestUserInputResponse', 'ServerRequestResolvedNotification', 'ThreadTokenUsageUpdatedNotification']) collect(`v2/${name}.ts`)
  const entries = [...files].sort(([left], [right]) => left.localeCompare(right))
  const hashes = Object.fromEntries(entries.map(([path, contents]) => [relative(temporary, path), createHash('sha256').update(contents).digest('hex')]))
  const manifest = `export const protocolVersion = ${JSON.stringify(version)}\nexport const protocolSources = ${JSON.stringify(hashes, null, 2)} as const\n`
  const changes = entries.map(([path, contents]) => [join(root, 'executor-codex/protocol', version, relative(temporary, path)), contents])
  changes.push([join(root, 'executor-codex/protocol/manifest.ts'), manifest])
  const patch = ['*** Begin Patch']
  for (const [path, contents] of changes) {
    if (existsSync(path)) {
      const before = readFileSync(path, 'utf8')
      if (before === contents) continue
      patch.push(`*** Update File: ${path}`, '@@', ...before.trimEnd().split('\n').map(line => `-${line}`), ...contents.trimEnd().split('\n').map(line => `+${line}`))
    } else patch.push(`*** Add File: ${path}`, ...contents.trimEnd().split('\n').map(line => `+${line}`))
  }
  patch.push('*** End Patch')
  execFileSync('apply_patch', [], { input: `${patch.join('\n')}\n`, stdio: ['pipe', 'inherit', 'inherit'] })
} finally { rmSync(temporary, { recursive: true, force: true }) }
