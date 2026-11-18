import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { destination: { type: 'string' }, state: { type: 'string' }, 'projects-root': { type: 'string' } } })
if (values.state && values['projects-root']) throw new Error('Choose session project mode or explicit fixed state, not both')
if (!values.destination) throw new Error('Specify --destination for an explicit local plugin copy; no global install is performed')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const destination = resolve(values.destination)
const local = relative(root, destination)
if (!local.startsWith('..')) throw new Error('Destination must be outside the source repository')
const cli = await realpath(join(root, 'packages/dist/service/src/cli.js'))
await mkdir(destination, { mode: 0o700 })
await cp(join(root, 'plugins/superagent'), destination, { recursive: true, force: false, errorOnExist: true })
const args = [cli, 'mcp', 'bridge', ...(values.state ? ['--state', resolve(values.state)] : values['projects-root'] ? ['--projects-root', resolve(values['projects-root'])] : [])]
await writeFile(join(destination, '.mcp.json'), JSON.stringify({ mcpServers: { superagent: { command: await realpath(process.execPath), args } } }, null, 2), { mode: 0o600 })
JSON.parse(await readFile(join(destination, '.codex-plugin/plugin.json'), 'utf8'))
console.log(`Prepared ${destination}. Runtime remains at ${root}; moving/removing it requires reconfiguration. No marketplace, Codex configuration, login or daemon was modified.`)
