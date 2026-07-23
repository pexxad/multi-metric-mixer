import { rm } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('dist/server', { recursive: true, force: true })
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: false,
  packages: 'external',
  external: ['better-sqlite3'],
  logLevel: 'info',
}
await Promise.all([
  build({ ...common, entryPoints: ['src/bff/index.ts'], outfile: 'dist/server/bff.mjs' }),
  build({ ...common, entryPoints: ['src/mcp-server/index.ts'], outfile: 'dist/server/mcp.mjs' }),
])
