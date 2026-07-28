import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backendRuntimeConfigSchema, type BackendRuntimeConfig } from './config'
import { createMcpRequestHandler } from './mcp-adapter'
import type { BackendCore } from '../backend-core/runtime'
import { backendContext, testBackendAccessTokenKeys } from '../test-support'
import { BackendAccessTokenIssuer, BackendAccessTokenVerifier } from '../shared/backend-access-token'
import { createBackendServerServices, type BackendServerServices } from './runtime'

const keys = testBackendAccessTokenKeys()
const config: BackendRuntimeConfig = backendRuntimeConfigSchema.parse({
  release: 'test',
  backendServer: { hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000',
    audience: 'http://127.0.0.1:3001', tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPublicKeyBase64: keys.publicKeyBase64 },
  backendStorage: { driver: 'sqlite', sqlitePath: ':memory:', artifactPath: '/tmp/multi-metric-mixer-backend-tests' },
  limits: { apiBodyBytes: 262_144, uploadBytes: 1_048_576, sourceResponseBytes: 2_097_152, sourceRows: 5_000, jsonDepth: 32, concurrentRunsPerWorkspace: 2 },
  sourceNetwork: { allowedPrivateHosts: [], allowedHttpHosts: [] },
  connectionProfiles: { filePath: '/tmp/multi-metric-mixer-test-connection-profiles.json' },
})

describe('instance-local MCP handler', () => {
  let services: BackendCore
  let backendServices: BackendServerServices
  const context = backendContext()
  let handler: ReturnType<typeof createMcpRequestHandler>
  let accessToken: string
  const issuer = new BackendAccessTokenIssuer({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
    keyId: 'test-1', privateKeyBase64: keys.privateKeyBase64, ttlSeconds: 15 })

  beforeEach(async () => {
    accessToken = await issuer.issue(context, ['backend:mcp'])
    backendServices = await createBackendServerServices(config)
    services = backendServices.core
    handler = createMcpRequestHandler({
      expectedHost: '127.0.0.1:3001', expectedOrigin: 'http://127.0.0.1:3000',
      verifier: new BackendAccessTokenVerifier({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
        keyId: 'test-1', publicKeyBase64: keys.publicKeyBase64 }),
      invocations: services.invocations,
      dependencies: { sources: services.sources, reader: services.reader, artifacts: services.artifacts, tools: services.tools,
        workflowExecution: services.execution, workflows: services.workflows, catalogs: services.catalogs,
        exploration: services.exploration },
    })
  })
  afterEach(async () => backendServices.close())

  async function call(body: Record<string, unknown>, overrides: Record<string, string> = {}) {
    return handler(new Request('http://127.0.0.1:3001/mcp', {
      method: 'POST',
      headers: {
        Host: '127.0.0.1:3001', Origin: 'http://127.0.0.1:3000', Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...overrides,
      },
      body: JSON.stringify(body),
    }))
  }

  async function jsonRpc(response: Response) {
    const text = await response.text()
    const event = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
    return JSON.parse(event ?? text) as { result?: {
      isError?: boolean
      content?: Array<{ type: string; text?: string }>
      tools?: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
      outputSchema?: Record<string, unknown>
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
    }> } }
  }

  it('rejects requests without exact Host and Origin before protocol handling', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
    expect((await call(body, { Origin: '' })).status).toBe(403)
    expect((await call({ ...body, id: 2 }, { Origin: 'null' })).status).toBe(403)
    expect((await call(body, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await call({ ...body, id: 3 }, { Host: 'localhost:3001' })).status).toBe(403)
  })

  it('uses stable SDK transport and exposes the exact typed tool set with explicit behavior annotations', async () => {
    const initialize = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } })
    expect(initialize.status).toBe(200)
    const listed = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(listed.status).toBe(200)
    const tools = (await jsonRpc(listed)).result?.tools ?? []
    expect(tools.map(({ name }) => name)).toEqual([
      'data_source_list', 'data_source_describe', 'data_source_query_template_list', 'data_source_query_template_describe',
      'data_source_read', 'data_source_sample', 'data_source_profile', 'catalog_explore_personal',
      'catalog_list', 'catalog_describe', 'catalog_save_personal', 'catalog_reset_personal', 'catalog_save_canonical',
      'catalog_promote_personal', 'documents_to_table',
      'table_aggregate', 'table_filter_select', 'table_derive', 'table_join', 'table_join_aggregate', 'table_sort_limit',
      'artifact_preview', 'csv_export', 'workflow_validate', 'workflow_list', 'workflow_get', 'workflow_save',
      'workflow_archive', 'workflow_execute',
    ])
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true)
    expect(tools.every((tool) => ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .every((key) => typeof tool.annotations?.[key as keyof NonNullable<typeof tool.annotations>] === 'boolean'))).toBe(true)
    expect(tools.find((tool) => tool.name === 'data_source_list')?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    expect(tools.find((tool) => tool.name === 'data_source_read')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true })
    expect(tools.find((tool) => tool.name === 'data_source_read')?.annotations?.openWorldHint).toBe(true)
    expect(tools.find((tool) => tool.name === 'catalog_describe')?.annotations?.openWorldHint).toBe(false)
    expect(tools.find((tool) => tool.name === 'workflow_execute')?.annotations?.openWorldHint).toBe(true)
    const documentsToTable = tools.find((tool) => tool.name === 'documents_to_table')
    expect(documentsToTable?.description).toContain('recordPathは$')
    expect(JSON.stringify(documentsToTable?.inputSchema)).toContain('Do not use $[], [*], or []')
    const derive = tools.find((tool) => tool.name === 'table_derive')
    expect(JSON.stringify(derive?.inputSchema)).toContain('Use either operandField or operandValue')
    expect(tools.find((tool) => tool.name === 'data_source_read')?.description).toContain('返すartifactId')
    expect(tools.find((tool) => tool.name === 'table_join')?.description).toContain('source IDは指定しません')
    expect(tools.find((tool) => tool.name === 'table_join_aggregate')?.description).toContain('右マスタ')
  })

  it('returns application failures as MCP tool errors that an agent can inspect', async () => {
    const response = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'data_source_describe', arguments: { source: 'missing-source' } },
    })
    const result = (await jsonRpc(response)).result
    expect(response.status).toBe(200)
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('登録されていません')
  })
})
