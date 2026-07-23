import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { loadMcpRuntimeConfig } from '../server/config'
import { createMcpServices } from './runtime'
import { createMcpRequestHandler } from './server'

const config = loadMcpRuntimeConfig()
const services = await createMcpServices(config)
const app = new Hono()
const handler = createMcpRequestHandler({
  expectedHost: `${config.mcpServer.hostname}:${config.mcpServer.port}`,
  expectedOrigin: config.mcpServer.origin,
  grants: services.grants,
  invocations: services.invocations,
  dependencies: { sources: services.sources, reader: services.reader, artifacts: services.artifacts,
    tools: services.tools, workflows: services.execution },
})
app.use('/mcp', bodyLimit({ maxSize: config.limits.apiBodyBytes,
  onError: (c) => c.json({ error: 'request_body_too_large' }, 413) }))
app.all('/mcp', (c) => handler(c.req.raw))
app.get('/health', (c) => c.req.header('Host') === `${config.mcpServer.hostname}:${config.mcpServer.port}`
  && c.req.header('Origin') === config.mcpServer.origin
  ? c.json({ status: 'ok', service: 'multi-metric-mixer-mcp', release: config.release })
  : c.json({ error: 'invalid_internal_caller' }, 403))

const server = serve({ fetch: app.fetch, hostname: config.mcpServer.hostname, port: config.mcpServer.port }, (info) => {
  if (info.address !== '127.0.0.1') throw new Error(`MCP refused non-loopback bind: ${info.address}`)
  console.log(JSON.stringify({ event: 'mcp_server_started', address: info.address, port: info.port, release: config.release }))
})

let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(JSON.stringify({ event: 'mcp_shutdown_started', signal }))
  server.close(() => { void services.close().finally(() => process.exit(0)) })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
