import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function files(path) {
  const value = await stat(path)
  if (value.isFile()) return [path]
  return (await Promise.all((await readdir(path)).map((name) => files(join(path, name))))).flat()
}

async function bytes(path) {
  const value = await stat(path)
  if (value.isFile()) return value.size
  return (await Promise.all((await readdir(path)).map((name) => bytes(join(path, name))))).reduce((a, b) => a + b, 0)
}

async function inspectArtifacts() {
  const excluded = ['samples/mock-rest-api', 'local/compose.yaml', 'local-password', 'local-client-secret', 'scripts/local.mjs']
  for (const file of await files('dist')) {
    const source = await readFile(file, 'utf8')
    for (const marker of excluded) {
      if (source.includes(marker)) throw new Error(`${file} contains local-only marker: ${marker}`)
    }
  }

  const bff = await readFile('dist/server/bff.mjs', 'utf8')
  const mcp = await readFile('dist/server/mcp.mjs', 'utf8')
  if (bff.includes('src/mcp-server/index.ts')) throw new Error('BFF bundle contains the MCP entrypoint')
  if (mcp.includes('src/bff/index.ts')) throw new Error('MCP bundle contains the BFF entrypoint')
  for (const marker of ['WebStandardStreamableHTTPServerTransport', 'DynamoDBClient', 'CloudWatchLogsClient']) {
    if (bff.includes(marker)) throw new Error(`BFF bundle contains MCP runtime dependency: ${marker}`)
  }
  for (const marker of ['openid-client', '__Host-session', 'auth/callback']) {
    if (mcp.includes(marker)) throw new Error(`MCP bundle contains BFF authentication dependency: ${marker}`)
  }

  return {
    bffBytes: await bytes('dist/server/bff.mjs'),
    mcpBytes: await bytes('dist/server/mcp.mjs'),
    clientBytes: await bytes('dist/client'),
  }
}

async function smokeTwoProcesses() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mmm-smoke-'))
  const bffPort = 34100 + Math.floor(Math.random() * 300)
  const mcpPort = bffPort + 500
  const bffOrigin = `http://127.0.0.1:${bffPort}`
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    APP_RELEASE: 'smoke',
    DATA_DIR: dataDir,
    PORT: String(bffPort),
    MCP_PORT: String(mcpPort),
    PUBLIC_ORIGIN: bffOrigin,
    ALLOWED_ORIGINS: bffOrigin,
    MCP_CALLER_ORIGIN: bffOrigin,
    AUTH_PROVIDER_KEY: 'smoke-oidc',
    OIDC_ISSUER: 'https://id.example.com',
    OIDC_CLIENT_ID: 'smoke',
    OIDC_REDIRECT_URI: `${bffOrigin}/auth/callback`,
    SESSION_SECRET: '01234567890123456789012345678901',
    AUTH_TRANSACTION_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  }
  const output = []
  const start = (file) => {
    const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => output.push(chunk.toString()))
    child.stderr.on('data', (chunk) => output.push(chunk.toString()))
    return child
  }
  const waitFor = async (url) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url)
        if (response.ok) return
      } catch { /* Processes are still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${url}\n${output.join('')}`)
  }

  const mcp = start('dist/server/mcp.mjs')
  const bff = start('dist/server/bff.mjs')
  const exits = [new Promise((resolve) => mcp.once('exit', resolve)), new Promise((resolve) => bff.once('exit', resolve))]
  try {
    await waitFor(`${bffOrigin}/ready`)
    const publicMcp = await fetch(`${bffOrigin}/mcp`, { method: 'POST' })
    if (publicMcp.status !== 404) throw new Error(`Public BFF unexpectedly exposed /mcp: ${publicMcp.status}`)
    const directMcp = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'POST', body: '{}' })
    if (directMcp.status !== 403) throw new Error(`MCP did not reject a direct request: ${directMcp.status}`)
    return { bffPort, mcpPort, publicMcp: publicMcp.status, directMcp: directMcp.status }
  } finally {
    if (bff.exitCode === null) bff.kill('SIGTERM')
    if (mcp.exitCode === null) mcp.kill('SIGTERM')
    await Promise.race([Promise.allSettled(exits), new Promise((resolve) => setTimeout(resolve, 3_000))])
    await rm(dataDir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ event: 'production_verified', artifacts: await inspectArtifacts(), processes: await smokeTwoProcesses() }))
