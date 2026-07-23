import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'

const hasPrivateKey = Boolean(process.env.BACKEND_TOKEN_PRIVATE_KEY_BASE64)
const hasPublicKey = Boolean(process.env.BACKEND_TOKEN_PUBLIC_KEY_BASE64)
if (hasPrivateKey !== hasPublicKey) {
  throw new Error('BACKEND_TOKEN_PRIVATE_KEY_BASE64 and BACKEND_TOKEN_PUBLIC_KEY_BASE64 must be configured together.')
}
const pair = hasPrivateKey ? undefined : generateKeyPairSync('ed25519')
const privateKey = process.env.BACKEND_TOKEN_PRIVATE_KEY_BASE64
  ?? pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const publicKey = process.env.BACKEND_TOKEN_PUBLIC_KEY_BASE64
  ?? pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

function without(source, names, prefixes = []) {
  return Object.fromEntries(Object.entries(source)
    .filter(([name]) => !names.includes(name) && !prefixes.some((prefix) => name.startsWith(prefix))))
}

const bffEnvironment = {
  ...without(process.env, [
    'BACKEND_TOKEN_PUBLIC_KEY_BASE64',
    'BACKEND_DATABASE_URL_SECRET_ID',
    'BACKEND_STORAGE_DRIVER',
    'BACKEND_DATA_DIR',
    'DATA_SOURCE_SECRET_PROVIDER',
    'DATA_SOURCE_SECRET_PREFIX',
    'DATA_SOURCE_SECRET_FILE',
  ], ['ARTIFACT_', 'SOURCE_ALLOWED_']),
  BACKEND_TOKEN_PRIVATE_KEY_BASE64: privateKey,
}
const backendEnvironment = {
  ...without(process.env, [
    'BACKEND_TOKEN_PRIVATE_KEY_BASE64',
    'PORT',
    'PUBLIC_ORIGIN',
    'ALLOWED_ORIGINS',
    'BFF_DATABASE_URL_SECRET_ID',
    'BFF_STORAGE_DRIVER',
    'BFF_DATA_DIR',
    'SESSION_SECRET',
    'AUTH_TRANSACTION_SECRET',
  ], ['AUTH_', 'OIDC_', 'AGENT_', 'OPENAI_COMPATIBLE_']),
  BACKEND_TOKEN_PUBLIC_KEY_BASE64: publicKey,
}
const browserEnvironment = without(process.env, [
  'BACKEND_TOKEN_PRIVATE_KEY_BASE64',
  'BACKEND_TOKEN_PUBLIC_KEY_BASE64',
  'OIDC_CLIENT_SECRET',
  'SESSION_SECRET',
  'AUTH_TRANSACTION_SECRET',
  'OPENAI_COMPATIBLE_API_KEY',
], ['AUTH_', 'OIDC_', 'AGENT_', 'OPENAI_COMPATIBLE_', 'DATA_SOURCE_SECRET_', 'ARTIFACT_'])

const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/bff/index.ts'], { env: bffEnvironment, stdio: 'inherit' }),
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/backend-server/index.ts'], { env: backendEnvironment, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { env: browserEnvironment, stdio: 'inherit' }),
]

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill(signal)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))
for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping) stop()
    process.exitCode = code ?? 0
  })
}
