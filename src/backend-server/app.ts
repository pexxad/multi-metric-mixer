import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { BackendRuntimeConfig } from './config'
import type { BackendServerServices } from './runtime'
import { BackendAccessTokenVerifier } from '../shared/backend-access-token'
import { createMcpRequestHandler } from './mcp-adapter'
import { createBackendApiAdapter } from './api-adapter'

export function createBackendApp(config: BackendRuntimeConfig, services: BackendServerServices) {
  const { core } = services
  const expectedHost = `${config.backendServer.hostname}:${config.backendServer.port}`
  const verifier = new BackendAccessTokenVerifier({
    issuer: config.backendServer.tokenIssuer,
    audience: config.backendServer.audience,
    keyId: config.backendServer.tokenKeyId,
    publicKeyBase64: config.backendServer.tokenPublicKeyBase64,
  })
  const app = new Hono()
  const mcp = createMcpRequestHandler({
    expectedHost,
    expectedOrigin: config.backendServer.origin,
    verifier,
    invocations: core.invocations,
    dependencies: {
      sources: core.sources,
      reader: core.reader,
      artifacts: core.artifacts,
      tools: core.tools,
      workflowExecution: core.execution,
      workflows: core.workflows,
      catalogs: core.catalogs,
      exploration: core.exploration,
    },
  })
  app.use('/mcp', bodyLimit({
    maxSize: config.limits.apiBodyBytes,
    onError: (c) => c.json({ error: 'request_body_too_large' }, 413),
  }))
  app.all('/mcp', (c) => mcp(c.req.raw))
  app.route('/', createBackendApiAdapter({
    expectedHost,
    expectedOrigin: config.backendServer.origin,
    verifier,
    core,
    connectionProfiles: services.connectionProfiles,
  }))
  app.get('/health', (c) => c.req.header('Host') === expectedHost && c.req.header('Origin') === config.backendServer.origin
    ? c.json({ status: 'ok', service: 'multi-metric-mixer-backend', release: config.release })
    : c.json({ error: 'invalid_internal_caller' }, 403))
  return app
}
