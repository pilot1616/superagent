import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../executor-codex/native/process-snapshot.c', import.meta.url)), '-o', fileURLToPath(new URL('../dist/executor-codex/src/process-snapshot-darwin.bin', import.meta.url))], { stdio: 'inherit', timeout: 60_000 })
}
