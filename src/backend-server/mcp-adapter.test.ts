import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backendRuntimeConfigSchema, type BackendRuntimeConfig } from './config'
import { contentHash } from '../shared/canonical-hash'
import { createMcpRequestHandler } from './mcp-adapter'
import { createBackendCore, type BackendCore } from '../backend-core/runtime'
import { backendContext, testCapabilityKeys } from '../test-support'
import { BackendCapabilityIssuer, BackendCapabilityVerifier } from '../shared/backend-capability'

const keys = testCapabilityKeys()
const config: BackendRuntimeConfig = backendRuntimeConfigSchema.parse({
  release: 'test',
  backendServer: { hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000',
    audience: 'http://127.0.0.1:3001', tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPublicKeyBase64: keys.publicKeyBase64 },
  backendStorage: { driver: 'sqlite', sqlitePath: ':memory:', artifactPath: '/tmp/multi-metric-mixer-backend-tests' },
  limits: { apiBodyBytes: 262_144, uploadBytes: 1_048_576, sourceResponseBytes: 2_097_152, sourceRows: 5_000, jsonDepth: 32, concurrentRunsPerWorkspace: 2 },
  sourceNetwork: { allowedPrivateHosts: [], allowedHttpHosts: [] },
  sourceSecrets: { provider: 'file', filePath: '/tmp/multi-metric-mixer-test-source-secrets.json' },
})

describe('instance-local MCP handler', () => {
  let services: BackendCore
  const context = backendContext()
  let handler: ReturnType<typeof createMcpRequestHandler>
  const issuer = new BackendCapabilityIssuer({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
    keyId: 'test-1', privateKeyBase64: keys.privateKeyBase64, ttlSeconds: 15 })

  beforeEach(async () => {
    services = await createBackendCore(config)
    handler = createMcpRequestHandler({
      expectedHost: '127.0.0.1:3001', expectedOrigin: 'http://127.0.0.1:3000',
      verifier: new BackendCapabilityVerifier({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
        keyId: 'test-1', publicKeyBase64: keys.publicKeyBase64 }),
      invocations: services.invocations,
      dependencies: { sources: services.sources, reader: services.reader, artifacts: services.artifacts, tools: services.tools,
        workflowExecution: services.execution, workflows: services.workflows, catalogs: services.catalogs },
    })
  })
  afterEach(async () => services.close())

  async function call(body: Record<string, unknown>, overrides: Record<string, string> = {}) {
    const action = body.method === 'tools/call'
      ? String((body.params as { name: string }).name)
      : `mcp:${String(body.method)}`
    const capability = issuer.issue({ ...context, requestId: `request-${String(body.id)}` }, {
      action, inputHash: contentHash(body), scopes: ['backend:mcp', `tool:${action}`],
    })
    return handler(new Request('http://127.0.0.1:3001/mcp', {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001', Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${capability}`,
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
      'data_source_list', 'data_source_describe', 'data_source_read', 'data_source_profile', 'catalog_explore_personal',
      'catalog_list', 'catalog_describe', 'catalog_save_personal', 'catalog_reset_personal', 'catalog_save_canonical',
      'catalog_promote_personal',
      'table_aggregate', 'table_filter_select', 'table_derive', 'table_join', 'table_join_aggregate', 'table_sort_limit',
      'artifact_preview', 'csv_export', 'workflow_validate', 'workflow_list', 'workflow_get', 'workflow_save',
      'workflow_archive', 'workflow_execute',
    ])
  })
})
