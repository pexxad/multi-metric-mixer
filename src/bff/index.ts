import { serve } from '@hono/node-server'
import { createPublicApp } from './app'
import { loadRuntimeConfig } from './config'
import { createBffServices } from './runtime'

const config = loadRuntimeConfig()
const services = await createBffServices(config)
const app = createPublicApp({ config, services })
const server = serve({ fetch: app.fetch, hostname: config.publicServer.hostname, port: config.publicServer.port },
  (info) => console.log(JSON.stringify({
    event: 'bff_started',
    address: info.address,
    port: info.port,
    release: config.release,
    agentProvider: services.agent.model.metadata.provider,
    ...(services.agent.model.metadata.model ? { agentModel: services.agent.model.metadata.model } : {}),
  })))

let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(JSON.stringify({ event: 'bff_shutdown_started', signal }))
  server.close(() => { void services.close().finally(() => process.exit(0)) })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
