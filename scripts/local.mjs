import { copyFile, chmod, mkdir } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'

await mkdir('.data', { recursive: true, mode: 0o700 })
await copyFile('local/source-secrets.json', '.data/local-source-secrets.json')
await chmod('.data/local-source-secrets.json', 0o600)

const compose = spawnSync('docker', ['compose', '-f', 'local/compose.yaml', 'up', '-d', '--wait'], { stdio: 'inherit' })
if (compose.error || compose.status !== 0) {
  console.error('Docker Composeでローカルサービスを起動できませんでした。Dockerが起動しているか確認してください。')
  process.exit(compose.status ?? 1)
}

const discovery = 'http://127.0.0.1:8080/realms/multi-metric-mixer/.well-known/openid-configuration'
const deadline = Date.now() + 120_000
while (true) {
  try { if ((await fetch(discovery)).ok) break } catch { /* Keycloak is still starting. */ }
  if (Date.now() >= deadline) throw new Error('Keycloakが120秒以内にreadyになりませんでした。')
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

console.log('Local services are ready. Admin: admin@example.com / local-password; User: alice@example.com / local-password')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const detached = process.platform !== 'win32'
const app = spawn(npm, ['run', 'dev'], { stdio: 'inherit', detached })
let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping || app.exitCode !== null) return
  stopping = true
  if (detached && app.pid) process.kill(-app.pid, signal)
  else app.kill(signal)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))
process.on('exit', () => stop())
app.on('exit', (code) => process.exit(code ?? 0))
