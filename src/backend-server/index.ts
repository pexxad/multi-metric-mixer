import { serve } from '@hono/node-server'
import { createBackendCore } from '../backend-core/runtime'
import { loadBackendRuntimeConfig } from './config'
import { createBackendApp } from './app'

const config = loadBackendRuntimeConfig()
const core = await createBackendCore(config)
const app = createBackendApp(config, core)

const server = serve({
  fetch: app.fetch,
  hostname: config.backendServer.hostname,
  port: config.backendServer.port,
}, (info) => {
  if (info.address !== '127.0.0.1') throw new Error(`Backend refused non-loopback bind: ${info.address}`)
  console.log(JSON.stringify({ event: 'backend_server_started', address: info.address, port: info.port, release: config.release }))
})

let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(JSON.stringify({ event: 'backend_shutdown_started', signal }))
  server.close(() => { void core.close().finally(() => process.exit(0)) })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
