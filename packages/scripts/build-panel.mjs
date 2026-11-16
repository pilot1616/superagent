import { build } from 'esbuild'
import { cp, mkdir, chmod } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
await mkdir(join(root, 'packages/dist/panel'), { recursive: true })
await build({ entryPoints: [join(root, 'apps/panel/src/index.tsx')], outfile: join(root, 'packages/dist/panel/panel.js'), bundle: true, minify: true, platform: 'browser', target: ['es2022'], nodePaths: [join(root, 'packages/node_modules')], define: { 'process.env.NODE_ENV': '"production"' } })
await cp(join(root, 'apps/panel/index.html'), join(root, 'packages/dist/panel/index.html'))
await cp(join(root, 'LICENSE'), join(root, 'packages/dist/LICENSE'))
await chmod(join(root, 'packages/dist/service/src/cli.js'), 0o755)
