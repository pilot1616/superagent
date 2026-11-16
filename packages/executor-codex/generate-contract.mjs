import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
if (version !== 'codex-cli 0.154.0-alpha.6.2') throw new Error(`Unexpected version: ${version}`)
const temporary = mkdtempSync(join(tmpdir(), 'superagent-contract-'))
const destination = join(dirname(fileURLToPath(import.meta.url)), 'protocol', '0.154.0-alpha.6.2')
const roots = ['v2/ThreadStartParams.ts', 'v2/ThreadResumeParams.ts', 'v2/ThreadReadParams.ts', 'v2/TurnStartParams.ts', 'v2/TurnSteerParams.ts', 'v2/TurnInterruptParams.ts']
const visited = new Set()
try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', temporary], { stdio: 'pipe' })
  const copy = relative => {
    if (visited.has(relative)) return
    visited.add(relative)
    const source = readFileSync(join(temporary, relative), 'utf8')
    mkdirSync(dirname(join(destination, relative)), { recursive: true })
    writeFileSync(join(destination, relative), source)
    for (const match of source.matchAll(/from "(\.[^"]+)"/g)) {
      const dependency = resolve(dirname(join(temporary, relative)), `${match[1]}.ts`).slice(temporary.length + 1)
      copy(dependency)
    }
  }
  roots.forEach(copy)
  writeFileSync(join(destination, 'version.json'), `${JSON.stringify({ version, roots, generatedFiles: visited.size }, null, 2)}\n`)
  console.log(`Generated ${visited.size} version-pinned protocol files`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
