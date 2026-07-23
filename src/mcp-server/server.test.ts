import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpRuntimeConfigSchema, type McpRuntimeConfig } from '../server/config'
import { contentHash } from '../server/persistence/workflow-repository'
import { createMcpRequestHandler } from './server'
import { createMcpServices, type McpServices } from './runtime'
import { IdentityRepository } from '../server/persistence/identity-repository'
import { SessionService } from '../server/auth/session-service'

const sessionSecret = 'session-secret-that-is-at-least-32-characters'
const config: McpRuntimeConfig = mcpRuntimeConfigSchema.parse({
  release: 'test', publicOrigin: 'http://localhost:3000',
  mcpServer: { hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000', grantTtlSeconds: 30 },
  storage: { driver: 'sqlite', sqlitePath: ':memory:', artifactPath: '/tmp/multi-metric-mixer-mcp-tests' },
  limits: { apiBodyBytes: 262_144, uploadBytes: 1_048_576, sourceResponseBytes: 2_097_152, sourceRows: 5_000, jsonDepth: 32, concurrentRunsPerWorkspace: 2 },
  sourceNetwork: { allowedPrivateHosts: [], allowedHttpHosts: [] },
  sourceSecrets: { provider: 'file', filePath: '/tmp/multi-metric-mixer-test-source-secrets.json' },
})

describe('instance-local MCP handler', () => {
  let services: McpServices
  let context: Awaited<ReturnType<SessionService['create']>>['identity']
  let handler: ReturnType<typeof createMcpRequestHandler>

  beforeEach(async () => {
    services = await createMcpServices(config)
    const identity = await new IdentityRepository(services.database).resolve({ providerKey: 'oidc-main', subject: 'alice', displayName: 'Alice',
      groups: [], applicationRole: 'user', assuranceLevel: 'basic' })
    context = (await new SessionService(services.database, sessionSecret, 3600).create(identity)).identity
    handler = createMcpRequestHandler({
      expectedHost: '127.0.0.1:3001', expectedOrigin: 'http://127.0.0.1:3000', grants: services.grants,
      invocations: services.invocations,
      dependencies: { sources: services.sources, reader: services.reader, artifacts: services.artifacts, tools: services.tools,
        workflows: services.execution },
    })
  })
  afterEach(async () => services.close())

  async function call(body: Record<string, unknown>, overrides: Record<string, string> = {}) {
    const action = body.method === 'tools/call'
      ? String((body.params as { name: string }).name)
      : `mcp:${String(body.method)}`
    const grant = await services.grants.issue({ ...context, requestId: `request-${String(body.id)}` }, { action, inputHash: contentHash(body) })
    return handler(new Request('http://127.0.0.1:3001/mcp', {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001', Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${grant}`,
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...overrides,
      },
      body: JSON.stringify(body),
    }))
  }

  async function jsonRpc(response: Response) {
    const text = await response.text()
    const event = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    return JSON.parse(event ?? text) as { result?: { tools?: Array<{ name: string }> } }
  }

  it('rejects requests without exact Host and Origin before protocol handling', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
    expect((await call(body, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await call({ ...body, id: 2 }, { Host: 'localhost:3001' })).status).toBe(403)
  })

  it('uses stable SDK transport and exposes only the exact read-only data-source tool set', async () => {
    const initialize = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } })
    expect(initialize.status).toBe(200)
    const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(listed.status).toBe(200)
    expect((await jsonRpc(listed)).result?.tools?.map(({ name }) => name)).toEqual([
      'data_source_list', 'data_source_describe', 'data_source_read', 'data_source_profile',
      'table_aggregate', 'table_filter_select', 'table_derive', 'table_join', 'table_join_aggregate', 'table_sort_limit',
      'artifact_preview', 'csv_export', 'workflow_validate', 'workflow_execute',
    ])
  })
})
