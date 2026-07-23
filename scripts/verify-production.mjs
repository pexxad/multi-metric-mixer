import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

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
  const backend = await readFile('dist/server/backend.mjs', 'utf8')
  if (bff.includes('src/backend-server/index.ts')) throw new Error('BFF bundle contains the Backend entrypoint')
  if (backend.includes('src/bff/index.ts')) throw new Error('Backend bundle contains the BFF entrypoint')
  for (const marker of ['WebStandardStreamableHTTPServerTransport', 'DynamoDBClient', 'CloudWatchLogsClient']) {
    if (bff.includes(marker)) throw new Error(`BFF bundle contains Backend runtime dependency: ${marker}`)
  }
  for (const marker of ['openid-client', '__Host-session', 'auth/callback']) {
    if (backend.includes(marker)) throw new Error(`Backend bundle contains BFF authentication dependency: ${marker}`)
  }

  return {
    bffBytes: await bytes('dist/server/bff.mjs'),
    backendBytes: await bytes('dist/server/backend.mjs'),
    clientBytes: await bytes('dist/client'),
  }
}

async function smokeTwoProcesses() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mmm-smoke-'))
  const bffPort = 34100 + Math.floor(Math.random() * 300)
  const backendPort = bffPort + 500
  const bffOrigin = `http://127.0.0.1:${bffPort}`
  const keyPair = generateKeyPairSync('ed25519')
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production',
    APP_RELEASE: 'smoke',
    PORT: String(bffPort),
    BACKEND_PORT: String(backendPort),
    PUBLIC_ORIGIN: bffOrigin,
    ALLOWED_ORIGINS: bffOrigin,
    BACKEND_CALLER_ORIGIN: bffOrigin,
    BACKEND_AUDIENCE: `http://127.0.0.1:${backendPort}`,
    BACKEND_TOKEN_ISSUER: 'smoke-bff',
    BACKEND_TOKEN_KEY_ID: 'smoke-1',
    AUTH_PROVIDER_KEY: 'smoke-oidc',
    OIDC_ISSUER: 'https://id.example.com',
    OIDC_CLIENT_ID: 'smoke',
    OIDC_REDIRECT_URI: `${bffOrigin}/auth/callback`,
    SESSION_SECRET: '01234567890123456789012345678901',
    AUTH_TRANSACTION_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
  }
  const bffEnv = {
    ...baseEnv,
    BFF_STORAGE_DRIVER: 'sqlite',
    BFF_DATA_DIR: join(dataDir, 'bff'),
    BACKEND_TOKEN_PRIVATE_KEY_BASE64: keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
  const backendEnv = {
    ...baseEnv,
    BACKEND_STORAGE_DRIVER: 'sqlite',
    BACKEND_DATA_DIR: join(dataDir, 'backend'),
    BACKEND_TOKEN_PUBLIC_KEY_BASE64: keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
  const output = []
  const start = (file, env) => {
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

  const backend = start('dist/server/backend.mjs', backendEnv)
  const bff = start('dist/server/bff.mjs', bffEnv)
  const exits = [new Promise((resolve) => backend.once('exit', resolve)), new Promise((resolve) => bff.once('exit', resolve))]
  try {
    await waitFor(`${bffOrigin}/ready`)
    const publicMcp = await fetch(`${bffOrigin}/mcp`, { method: 'POST' })
    if (publicMcp.status !== 404) throw new Error(`Public BFF unexpectedly exposed /mcp: ${publicMcp.status}`)
    const publicApi = await fetch(`${bffOrigin}/internal/api`, { method: 'POST' })
    if (publicApi.status !== 404) throw new Error(`Public BFF unexpectedly exposed /internal/api: ${publicApi.status}`)
    const directMcp = await fetch(`http://127.0.0.1:${backendPort}/mcp`, { method: 'POST', body: '{}' })
    if (directMcp.status !== 403) throw new Error(`MCP did not reject a direct request: ${directMcp.status}`)
    const directApi = await fetch(`http://127.0.0.1:${backendPort}/internal/api`, { method: 'POST', body: '{}' })
    if (directApi.status !== 403) throw new Error(`Internal API did not reject a direct request: ${directApi.status}`)
    return {
      bffPort,
      backendPort,
      publicMcp: publicMcp.status,
      publicApi: publicApi.status,
      directMcp: directMcp.status,
      directApi: directApi.status,
    }
  } finally {
    if (bff.exitCode === null) bff.kill('SIGTERM')
    if (backend.exitCode === null) backend.kill('SIGTERM')
    await Promise.race([Promise.allSettled(exits), new Promise((resolve) => setTimeout(resolve, 3_000))])
    await rm(dataDir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ event: 'production_verified', artifacts: await inspectArtifacts(), processes: await smokeTwoProcesses() }))
