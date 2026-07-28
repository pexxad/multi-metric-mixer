import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, writeFile } from 'node:fs/promises'
import { createPublicApp } from './app'
import { runtimeConfigSchema, type RuntimeConfig } from './config'
import { createBffServices, type BffServices } from './runtime'
import { sampleWorkflow, type Workflow } from '../shared/workflow'
import { AppError } from '../shared/errors'
import { testBackendAccessTokenKeys } from '../test-support'
import { backendRuntimeConfigSchema, type BackendRuntimeConfig } from '../backend-server/config'
import type { BackendCore } from '../backend-core/runtime'
import { createBackendApp } from '../backend-server/app'
import { createBackendServerServices, type BackendServerServices } from '../backend-server/runtime'

const accessTokenKeys = testBackendAccessTokenKeys()
const config: RuntimeConfig = runtimeConfigSchema.parse({
  version: 1,
  release: 'test',
  publicServer: { hostname: '127.0.0.1', port: 3000, origin: 'http://localhost:3000', allowedOrigins: ['http://localhost:3000'] },
  backendServer: {
    hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000', audience: 'http://127.0.0.1:3001',
    tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPrivateKeyBase64: accessTokenKeys.privateKeyBase64, tokenTtlSeconds: 15,
  },
  auth: {
    providerKey: 'oidc-main', sessionTtlSeconds: 3600,
    sessionSecret: 'session-secret-that-is-at-least-32-characters',
    transactionSecret: 'transaction-secret-that-is-at-least-32-characters',
    oidc: { issuer: 'https://id.example.com', clientId: 'test', redirectUri: 'http://localhost:3000/auth/callback',
      scopes: ['openid'], groupsClaim: 'groups', adminGroup: 'multi-metric-mixer-admins',
      providerLabel: 'Organization sign-in', logout: { mode: 'oidc' }, allowInsecureLoopback: false },
  },
  bffStorage: { driver: 'sqlite', sqlitePath: ':memory:' },
  limits: { apiBodyBytes: 262_144, uploadBytes: 1_048_576, sourceResponseBytes: 2_097_152, sourceRows: 5_000, jsonDepth: 32, concurrentRunsPerWorkspace: 2 },
})
const backendConfig: BackendRuntimeConfig = backendRuntimeConfigSchema.parse({
  release: 'test', publicOrigin: 'http://localhost:3000',
  backendServer: {
    hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000', audience: 'http://127.0.0.1:3001',
    tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPublicKeyBase64: accessTokenKeys.publicKeyBase64,
  },
  backendStorage: { driver: 'sqlite', sqlitePath: ':memory:', artifactPath: '/tmp/multi-metric-mixer-backend-tests' },
  limits: config.limits,
  sourceNetwork: { allowedPrivateHosts: [], allowedHttpHosts: [] },
  connectionProfiles: { filePath: '/tmp/multi-metric-mixer-test-connection-profiles.json' },
})
const restSourceRegistration = {
  id: 'sample-api', name: 'Sample API', type: 'rest-json' as const,
  baseUrl: 'https://api.example.com', path: '/data', method: 'GET' as const,
}
const tableSourceRegistration = {
  id: 'sales', name: 'Sales', type: 'database-table' as const,
  connectionId: 'db-a', table: 'sales', maxRows: 100,
}

describe('public Hono BFF', () => {
  let services: BffServices
  let backend: BackendCore
  let backendServices: BackendServerServices
  let app: ReturnType<typeof createPublicApp>

  beforeEach(async () => {
    await writeFile(backendConfig.connectionProfiles.filePath, JSON.stringify({ connections: [
      { id: 'db-a', displayName: 'DB A', dataModel: 'table', uri: 'sqlite:///tmp/multi-metric-mixer-test.sqlite', deniedDatasets: [] },
    ] }), { mode: 0o600 })
    await chmod(backendConfig.connectionProfiles.filePath, 0o600)
    backendServices = await createBackendServerServices(backendConfig)
    backend = backendServices.core
    const backendApp = createBackendApp(backendConfig, backendServices)
    const backendFetch: typeof fetch = async (input, init) => backendApp.request(input instanceof URL ? input.toString() : input, init)
    services = await createBffServices(config, { backendFetch })
    app = createPublicApp({ config, services })
  })
  afterEach(async () => {
    await services.close()
    await backendServices.close()
  })

  async function login(subject: string, applicationRole: 'admin' | 'user' = 'user') {
    const identity = await services.identities.resolve({
      providerKey: 'oidc-main', subject, displayName: subject, email: `${subject}@example.com`, groups: [], applicationRole,
      assuranceLevel: 'basic',
    })
    const session = await services.sessions.create(identity)
    return {
      identity,
      headers: { Cookie: `mmm_session=${session.token}`, Origin: config.publicServer.origin, 'X-CSRF-Token': session.csrfToken },
    }
  }

  it('exposes only configured provider metadata', async () => {
    expect(await (await app.request('/auth/providers')).json()).toEqual({ providers: [{ key: 'oidc-main', label: 'Organization sign-in' }] })
  })

  it('rejects unauthenticated API access and never mounts MCP on the public listener', async () => {
    expect((await app.request('/api/bootstrap')).status).toBe(401)
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(404)
  })

  it('exposes only sanitized logical connection profiles to administrators', async () => {
    const admin = await login('admin', 'admin')
    const user = await login('alice')
    const response = await app.request('/api/connection-profiles', { headers: admin.headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connections: [{ id: 'db-a', displayName: 'DB A', dataModel: 'table' }] })
    expect((await app.request('/api/connection-profiles', { headers: user.headers })).status).toBe(403)
  })

  it('requires both exact Origin and a valid CSRF token for mutations', async () => {
    const { headers } = await login('alice')
    const body = JSON.stringify({ workflow: sampleWorkflow, changeSource: 'manual' })
    expect((await app.request('/api/workflows', {
      method: 'POST', headers: { Cookie: headers.Cookie, 'X-CSRF-Token': headers['X-CSRF-Token'], 'Content-Type': 'application/json' }, body,
    })).status).toBe(403)
    expect((await app.request('/api/workflows', {
      method: 'POST', headers: { Cookie: headers.Cookie, Origin: headers.Origin, 'X-CSRF-Token': 'wrong', 'Content-Type': 'application/json' }, body,
    })).status).toBe(403)
  })

  it('returns structured health and request-correlated authentication errors', async () => {
    expect(await (await app.request('/health')).json()).toMatchObject({ status: 'ok', release: 'test' })
    const response = await app.request('/api/bootstrap')
    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({ code: 'authentication_required', status: 401, requestId: expect.any(String) })
  })

  it('persists named Workflow versions and returns them from bootstrap', async () => {
    const { headers } = await login('alice')
    const save = async (name: string) => app.request('/api/workflows', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: { ...sampleWorkflow, name }, changeSource: 'manual' }),
    })
    expect((await (await save('First')).json()).version).toBe(1)
    expect((await (await save('Second')).json()).version).toBe(2)
    const bootstrap = await (await app.request('/api/bootstrap', { headers })).json() as Record<string, unknown>
    expect(bootstrap).toMatchObject({
      workflows: [{ workflow: { name: 'Second' }, version: 2 }],
    })
    expect(bootstrap).not.toHaveProperty('agent')
    expect(bootstrap).not.toHaveProperty('mcp')
  })

  it('removes an archived Workflow from the management list while preserving its versions', async () => {
    const { headers } = await login('alice')
    const saveResponse = await app.request('/api/workflows', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: sampleWorkflow, changeSource: 'manual' }) })
    expect(saveResponse.status).toBe(201)
    const saved = await saveResponse.json() as { version: number }
    const archived = await app.request(`/api/workflows/${sampleWorkflow.id}`, { method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: saved.version }) })
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({ archived: true })
    expect(await (await app.request('/api/workflows', { headers })).json()).toEqual({ workflows: [] })
    expect((await app.request(`/api/workflows/${sampleWorkflow.id}`, { headers })).status).toBe(404)
    expect(await backend.database.query.selectFrom('workflow_versions').selectAll().where('workflow_id', '=', sampleWorkflow.id).execute()).toHaveLength(1)
  })

  it('allows only administrators to manage data sources while all Workspace members can select them', async () => {
    const alice = await login('alice', 'admin')
    const bob = await login('bob')
    expect((await app.request('/api/data-sources', {
      method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(restSourceRegistration),
    })).status).toBe(403)
    expect((await app.request('/api/data-sources', {
      method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(restSourceRegistration),
    })).status).toBe(201)
    const adminSources = await (await app.request('/api/data-sources', { headers: alice.headers })).json()
    const userSources = await (await app.request('/api/data-sources', { headers: bob.headers })).json()
    expect(adminSources).toMatchObject({ sources: [{ id: 'sample-api', accessMode: 'read-only', baseUrl: 'https://api.example.com' }] })
    expect(userSources).toMatchObject({ sources: [{ id: 'sample-api', dataModel: 'documents' }] })
    expect(JSON.stringify(userSources)).not.toContain('api.example.com')
    const bootstrap = await (await app.request('/api/bootstrap', { headers: alice.headers })).json()
    expect(JSON.stringify(bootstrap)).not.toContain('api.example.com')
    expect((await app.request('/api/data-sources/sample-api', { method: 'DELETE', headers: bob.headers })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api/impact', { headers: bob.headers })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api/test', { method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters: {} }) })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api', { method: 'PATCH', headers: { ...bob.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: restSourceRegistration, expectedVersion: 1 }) })).status).toBe(403)
    expect((await app.request('/api/uploads/json?filename=data.json&sourceId=uploaded&sourceName=Uploaded', {
      method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' }, body: '{}',
    })).status).toBe(403)
  })

  it('uses the Internal API for deterministic UI source tests and Catalog exploration', async () => {
    const admin = await login('deterministic-admin', 'admin')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(restSourceRegistration) })
    const artifact = { id: 'sample', type: 'documents' as const, name: 'sample', rowCount: 1, columns: ['value'], preview: [{ value: 1 }],
      provenance: ['source:sample-api'], trustLevel: 'untrusted' as const, classification: 'internal' as const,
      checksum: 'checksum', createdAt: new Date().toISOString() }
    const sourceTest = vi.spyOn(services.sources, 'test').mockResolvedValue(artifact)
    const catalogExplore = vi.spyOn(services.catalogs, 'explorePersonal').mockResolvedValue({
      observation: { sourceId: 'sample-api', observedAt: new Date().toISOString(), rowCount: 1, sampledRows: 1,
        schemaFingerprint: 'schema', dataModel: 'documents', fields: [] },
      catalog: { id: 'catalog', sourceId: 'sample-api', scope: 'personal', ownerId: admin.identity.principal.id, version: 1,
        definition: { sourceId: 'sample-api', displayName: 'Sample API', description: '', policy: 'evolving',
          classification: 'internal', dataModel: 'documents', defaultTimeField: null, fields: [], relationships: [] },
        schemaFingerprint: 'schema', changeSource: 'agent', createdBy: admin.identity.principal.id, createdAt: new Date().toISOString() },
      artifact,
    })
    const mcp = vi.spyOn(services.mcp, 'call')

    expect((await app.request('/api/data-sources/sample-api/test', { method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(200)
    expect((await app.request('/api/catalog/sample-api/explore', { method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(201)
    expect(sourceTest).toHaveBeenCalledWith(expect.anything(), 'sample-api')
    expect(catalogExplore).toHaveBeenCalledWith(expect.anything(), 'sample-api')
    expect(mcp).not.toHaveBeenCalled()
  })

  it('hides query-pattern implementation while exposing its generated input contract to users', async () => {
    const admin = await login('pattern-admin', 'admin')
    const user = await login('pattern-user')
    const source = { id: 'logs', name: 'Logs', type: 'cloudwatch-logs', region: 'ap-northeast-1',
      logGroupName: '/app/logs', maxResults: 1000, maxRangeSeconds: 86400, queryMode: 'template-required',
      queryTemplates: [{ id: 'errors', name: 'Errors', description: 'エラーを検索', outputDataModel: 'documents',
        variables: [
          { id: 'startTime', label: '開始', input: 'datetime', type: 'datetime', required: true },
          { id: 'endTime', label: '終了', input: 'datetime', type: 'datetime', required: true },
        ], execution: { kind: 'cloudwatch-logs-insights', query: 'fields @message | filter level = "ERROR"',
          startTimeVariable: 'startTime', endTimeVariable: 'endTime' } }] }
    expect((await app.request('/api/data-sources', { method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(source) })).status).toBe(201)
    const adminBody = JSON.stringify(await (await app.request('/api/data-sources', { headers: admin.headers })).json())
    const userBody = JSON.stringify(await (await app.request('/api/data-sources', { headers: user.headers })).json())
    expect(adminBody).toContain('filter level')
    expect(userBody).not.toContain('filter level')
    expect(userBody).toContain('"label":"開始"')
  })

  it('lets users keep personal Catalog changes while only administrators can change the Workspace canonical version', async () => {
    const admin = await login('catalog-admin', 'admin')
    const user = await login('catalog-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const definition = { sourceId: 'sales', displayName: '売上', description: '', policy: 'curated', classification: 'internal',
      defaultTimeField: null, relationships: [], fields: [{ path: 'amount', dataTypes: ['number'], nullable: false,
        presence: 1, businessName: '金額', description: '', unit: 'JPY', timezone: '' }] }
    expect((await app.request('/api/catalog/sales/canonical', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }) })).status).toBe(403)
    expect((await app.request('/api/catalog/sales/canonical', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }) })).status).toBe(201)
    expect((await app.request('/api/catalog/sales/personal', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { ...definition, displayName: '自分用売上' } }) })).status).toBe(201)
    expect(await (await app.request('/api/catalog/sales', { headers: user.headers })).json()).toMatchObject({
      canonical: { definition: { displayName: '売上' } }, personal: { definition: { displayName: '自分用売上' } },
      effective: { definition: { displayName: '自分用売上' } },
    })
    const reset = await (await app.request('/api/catalog/sales/personal', { method: 'DELETE', headers: user.headers })).json() as Record<string, unknown>
    expect(reset).toMatchObject({ effective: { definition: { displayName: '売上' } } })
    expect(reset).not.toHaveProperty('personal')
  })

  it('lets the Agent request bounded schema exploration and retries with the personal Catalog', async () => {
    const admin = await login('explore-admin', 'admin')
    const user = await login('explore-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const observation = { sourceId: 'sales', observedAt: '2026-07-22T00:00:00.000Z', rowCount: 1, sampledRows: 1,
      schemaFingerprint: 'schema-1', fields: [{ path: 'amount', dataTypes: ['number'], nullable: false, presence: 1,
        businessName: '', description: '', unit: '', timezone: '' }] }
    vi.spyOn(services.mcp, 'call').mockImplementation(async (context) => ({
      observation,
      catalog: await backend.catalogs.applyObservation(context, 'sales', observation),
      artifact: { id: 'exploration-artifact', type: 'table', name: 'sales-profile', rowCount: 1, columns: ['amount'],
        provenance: ['source:sales'], trustLevel: 'untrusted', classification: 'internal', checksum: 'exploration-checksum',
        createdAt: '2026-07-22T00:00:00.000Z' },
    }))
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'exploration', message: '項目を確認します。', changes: [], sourceIds: ['sales'], reason: 'Catalogが未登録です。' })
      .mockResolvedValueOnce({ state: 'clarification', message: '金額の期間を確認します。', changes: [],
        questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月'] }] })
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'explore-1', message: '売上を集計したい', workflow: sampleWorkflow }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'clarification', toolCalls: [
      { tool: 'catalog_explore_personal', label: '「Sales」のデータ構造を探索', status: 'completed' },
    ] })
    expect(services.mcp.call).toHaveBeenCalledWith(expect.anything(), 'catalog_explore_personal',
      { source: 'sales', limit: 100 })
    expect(respond).toHaveBeenCalledTimes(2)
    expect(respond.mock.calls[1]?.[0].catalogs).toMatchObject([{ sourceId: 'sales', scope: 'personal',
      definition: { fields: [{ path: 'amount' }] } }])
    expect(respond.mock.calls[1]?.[0].history).toEqual([])
    expect(respond.mock.calls[1]?.[0].currentTurn).toEqual({ events: [{
      type: 'catalog_explored', sourceIds: ['sales'], savedTo: 'personal-catalog',
    }] })
  })

  it('grounds a data-source answer with its structured Catalog through MCP', async () => {
    const admin = await login('answer-admin', 'admin')
    const user = await login('answer-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const definition = { sourceId: 'sales', displayName: '売上明細', description: '販売トランザクション', policy: 'curated',
      classification: 'internal', dataModel: 'table', defaultTimeField: null, relationships: [],
      fields: [{ path: 'amount', dataTypes: ['number'], nullable: false, presence: 1, repeated: false,
        businessName: '売上金額', description: '受注金額', unit: 'JPY', timezone: '' }] }
    expect((await app.request('/api/catalog/sales/canonical', { method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ definition }) })).status).toBe(201)
    vi.spyOn(services.agent, 'respond').mockResolvedValue({
      state: 'answer',
      message: 'salesの内容と項目を案内します。',
      changes: [],
      sourceIds: [],
      reason: 'catalog explanation',
    })
    const mcp = vi.spyOn(services.mcp, 'call')

    const response = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'answer-1', message: 'salesの内容と利用できる項目を教えてください', workflow: sampleWorkflow }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'answer',
      sourceIds: ['sales'],
      catalogs: [{ sourceId: 'sales', displayName: '売上明細', fields: [{ path: 'amount', businessName: '売上金額' }] }],
      toolCalls: [{ tool: 'catalog_describe', status: 'completed' }],
    })
    expect(mcp).toHaveBeenCalledWith(expect.anything(), 'catalog_describe', { sourceId: 'sales' })
    expect(services.agent.respond).toHaveBeenCalledTimes(2)
    expect(vi.mocked(services.agent.respond).mock.calls[1]?.[0].toolResults).toMatchObject([
      { tool: 'catalog_describe', input: { sourceId: 'sales' },
        result: { effective: { definition: { fields: [{ path: 'amount' }] } } } },
    ])
  })

  it('executes the exact saved Workflow through MCP and returns its final Artifact instead of a Catalog', async () => {
    const admin = await login('workflow-agent-admin', 'admin')
    const user = await login('workflow-agent-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const workflow: Workflow = {
      version: 1,
      id: 'wf-category-count',
      name: 'カテゴリ別レコード件数集計',
      description: 'カテゴリ別にレコード数を集計します。',
      steps: [
        { id: 'read-sales', kind: 'query', title: '売上を取得',
          config: { source: 'sales', parameters: {}, template: null } },
        { id: 'count-category', kind: 'aggregate', title: 'カテゴリ別に件数を集計', input: 'read-sales',
          config: { groupBy: 'category', metric: null, operation: 'count' } },
        { id: 'preview-result', kind: 'preview', title: '集計結果を表示', input: 'count-category', config: { limit: 10 } },
      ],
    }
    const savedResponse = await app.request('/api/workflows', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow, changeSource: 'agent' }) })
    expect(savedResponse.status).toBe(201)
    const saved = await savedResponse.json() as { version: number }
    const finalArtifact = {
      id: 'artifact-category-count', type: 'table' as const, name: 'カテゴリ別レコード件数',
      rowCount: 3, columns: ['category', 'count'],
      preview: [{ category: 'Hardware', count: 8 }, { category: 'Software', count: 7 }, { category: 'Services', count: 5 }],
      provenance: ['source:sales'], trustLevel: 'untrusted' as const, classification: 'internal' as const,
      checksum: 'category-count-checksum', createdAt: '2026-07-28T00:00:00.000Z',
    }
    const run = {
      id: 'run-category-count', workflowId: workflow.id, status: 'completed' as const,
      startedAt: '2026-07-28T00:00:00.000Z', durationMs: 12, stepCount: 3,
      finalArtifact,
    }
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'tool', message: '保存済みWorkflowを実行します。', changes: [],
        tool: 'workflow_execute', sourceId: '', artifactId: '', limit: 0, reason: '利用者が実行を依頼したためです。' })
      .mockResolvedValueOnce({ state: 'answer', message: 'カテゴリ別の件数を集計しました。', changes: [],
        sourceIds: ['sales'], reason: 'Workflowの実行結果を確認しました。' })
    const mcp = vi.spyOn(services.mcp, 'call').mockResolvedValue(run)

    const response = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'workflow-execute-1', message: 'ワークフローを実行してください', workflow }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      state: 'answer',
      catalogs: [],
      artifacts: [{ id: finalArtifact.id, preview: finalArtifact.preview }],
      workflowRun: { id: run.id, startedAt: run.startedAt, finalArtifact: { id: finalArtifact.id } },
      toolCalls: [{ tool: 'workflow_execute', status: 'completed' }],
    })
    expect(mcp).toHaveBeenCalledOnce()
    expect(mcp).toHaveBeenCalledWith(expect.anything(), 'workflow_execute',
      { workflowId: workflow.id, version: saved.version })
    expect(respond.mock.calls[0]?.[0].workflowExecution).toMatchObject({
      available: true, workflowId: workflow.id, version: saved.version, requiresApproval: false,
    })
    expect(respond.mock.calls[1]?.[0].toolResults).toMatchObject([
      { tool: 'workflow_execute', result: { finalArtifact: { id: finalArtifact.id } } },
    ])
  })

  it('lets the model compose multiple bounded MCP reads before its final answer', async () => {
    const admin = await login('tool-loop-admin', 'admin')
    const user = await login('tool-loop-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const artifact = { id: 'sample-read', type: 'table' as const, name: 'sales-sample', rowCount: 2,
      columns: ['category', 'amount'], preview: [{ category: 'Hardware', amount: 1200 }], provenance: ['source:sales'],
      trustLevel: 'untrusted' as const, classification: 'internal' as const, checksum: 'checksum', createdAt: '2026-07-27T00:00:00.000Z' }
    const catalog = { id: 'catalog-1', sourceId: 'sales', scope: 'canonical' as const, version: 1,
      definition: { sourceId: 'sales', displayName: '売上明細', description: '販売トランザクション', policy: 'curated' as const,
        classification: 'internal' as const, dataModel: 'table' as const, defaultTimeField: null, relationships: [],
        fields: [{ path: 'amount', dataTypes: ['number' as const], nullable: false, presence: 1, repeated: false,
          businessName: '売上金額', description: '受注金額', unit: 'JPY', timezone: '' }] },
      schemaFingerprint: 'schema', createdAt: '2026-07-27T00:00:00.000Z' }
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'tool', message: '項目を確認します。', changes: [], tool: 'catalog_describe',
        sourceId: 'sales', artifactId: '', limit: 0, reason: '項目の確認' })
      .mockResolvedValueOnce({ state: 'tool', message: '実データを取得します。', changes: [], tool: 'data_source_sample',
        sourceId: 'sales', artifactId: '', limit: 2, reason: '内容の確認' })
      .mockResolvedValueOnce({ state: 'tool', message: '実データを取得します。', changes: [], tool: 'data_source_sample',
        sourceId: 'sales', artifactId: '', limit: 2, reason: '内容の確認' })
      .mockResolvedValueOnce({ state: 'answer', message: '取得済みの内容を案内します。', changes: [],
        sourceIds: ['sales'], reason: '取得済み' })
      .mockResolvedValueOnce({ state: 'answer', message: '項目とサンプルを確認しました。', changes: [],
        sourceIds: ['sales'], reason: 'MCP結果で確認済み' })
    const mcp = vi.spyOn(services.mcp, 'call')
      .mockResolvedValueOnce({ sourceId: 'sales', canonical: catalog, effective: catalog, personalOutdated: false })
      .mockResolvedValueOnce(artifact)
      .mockResolvedValueOnce({ ...artifact, id: 'sample-preview' })

    const response = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'tool-loop-1', message: 'salesの項目と実データを見せて', workflow: sampleWorkflow }) })

    expect(response.status).toBe(200)
    const firstAnswer = await response.json() as { conversationId: string }
    expect(firstAnswer).toMatchObject({
      state: 'answer',
      catalogs: [{ sourceId: 'sales', fields: [{ path: 'amount' }] }],
      artifacts: [{ id: 'sample-preview', preview: [{ category: 'Hardware', amount: 1200 }] }],
      toolCalls: [
        { tool: 'catalog_describe', status: 'completed' },
        { tool: 'data_source_sample', status: 'completed' },
        { tool: 'artifact_preview', status: 'completed' },
      ],
    })
    expect(respond).toHaveBeenCalledTimes(5)
    expect(mcp).toHaveBeenCalledTimes(3)
    expect(respond.mock.calls[3]?.[0].toolResults).toMatchObject([
      { tool: 'catalog_describe', result: expect.anything() },
      { tool: 'data_source_sample', result: expect.anything() },
      { tool: 'data_source_sample', error: expect.stringContaining('すでに実行済み') },
    ])
    expect(respond.mock.calls[4]?.[0].toolResults).toHaveLength(4)

    respond.mockResolvedValueOnce({ state: 'answer', message: '表示済みの1行目を案内します。', changes: [],
      sourceIds: [], reason: '過去結果を参照' })
    const followUp = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: firstAnswer.conversationId, clientMessageId: 'tool-loop-follow-up',
        message: '表示した1行目を教えて', workflow: sampleWorkflow }) })
    expect(followUp.status).toBe(200)
    expect(respond.mock.calls[5]?.[0]).toMatchObject({
      message: '表示した1行目を教えて',
      priorResults: [{
        artifacts: [{ type: 'table', name: 'sales-sample', rowCount: 2,
          columns: ['category', 'amount'], preview: [{ category: 'Hardware', amount: 1200 }] }],
      }],
      currentTurn: { events: [] },
    })
    expect(respond.mock.calls[5]?.[0].toolResults).toBeUndefined()
  })

  it('bounds a model that keeps repeating the same MCP call without re-executing it', async () => {
    const user = await login('duplicate-tool-user')
    vi.spyOn(services.agent, 'respond').mockResolvedValue({
      state: 'tool', message: '一覧を確認します。', changes: [], tool: 'data_source_list',
      sourceId: '', artifactId: '', limit: 0, reason: '一覧の確認',
    })
    vi.spyOn(services.mcp, 'call').mockResolvedValue({ sources: [] })

    const response = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'duplicate-tool-1', message: '利用可能なデータを教えて', workflow: sampleWorkflow }) })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      code: 'agent_tool_limit_exceeded',
      title: '分析に必要なMCPツール呼び出しが上限を超えました。依頼を分けて再度お試しください。',
    })
    expect(services.mcp.call).toHaveBeenCalledTimes(1)
  })

  it('returns a safe MCP business error to the model so it can choose another tool', async () => {
    const admin = await login('tool-recovery-admin', 'admin')
    const user = await login('tool-recovery-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(tableSourceRegistration) })
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'tool', message: '詳細を確認します。', changes: [], tool: 'data_source_describe',
        sourceId: 'sales', artifactId: '', limit: 0, reason: '詳細の確認' })
      .mockResolvedValueOnce({ state: 'tool', message: '一覧で確認します。', changes: [], tool: 'data_source_list',
        sourceId: '', artifactId: '', limit: 0, reason: '別手段で確認' })
      .mockResolvedValueOnce({ state: 'answer', message: '利用可能なデータを確認しました。', changes: [],
        sourceIds: [], reason: '一覧結果で確認済み' })
    vi.spyOn(services.mcp, 'call')
      .mockRejectedValueOnce(new AppError('mcp_tool_error', 502, '一時的に詳細を取得できませんでした。'))
      .mockResolvedValueOnce({ sources: [{ id: 'sales', name: 'Sales', type: 'database-table', dataModel: 'table' }] })

    const response = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'tool-recovery-1', message: '利用可能なデータを教えて', workflow: sampleWorkflow }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'answer', toolCalls: [
      { tool: 'data_source_describe', status: 'failed' },
      { tool: 'data_source_list', status: 'completed' },
    ] })
    expect(respond.mock.calls[1]?.[0].toolResults).toMatchObject([
      { tool: 'data_source_describe', error: '一時的に詳細を取得できませんでした。' },
    ])
  })

  it('explores two sources through MCP and produces the exact joined aggregate result', async () => {
    const admin = await login('multi-source-admin', 'admin')
    const upload = (sourceId: string, sourceName: string, csv: string) => app.request(
      `/api/uploads/csv?filename=${sourceId}.csv&sourceId=${sourceId}&sourceName=${encodeURIComponent(sourceName)}`,
      { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'text/csv' }, body: csv },
    )
    expect((await upload('agent-sales', '売上明細', [
      'region_id,amount',
      'r1,100',
      'r1,50',
      'r2,80',
    ].join('\n'))).status).toBe(201)
    expect((await upload('agent-regions', '地域マスタ', [
      'region_id,region',
      'r1,East',
      'r2,West',
    ].join('\n'))).status).toBe(201)

    const proposedWorkflow: Workflow = {
      version: 1,
      id: 'wf-agent-region-sales',
      name: '地域別売上',
      description: '売上明細と地域マスタを結合し、地域別の売上合計を表示します。',
      steps: [
        { id: 'read-sales', kind: 'query', title: '売上明細を取得',
          config: { source: 'agent-sales', parameters: {}, template: null } },
        { id: 'amount-number', kind: 'derive', title: '売上金額を数値化', input: 'read-sales',
          config: { output: 'numeric_amount', operation: 'toNumber', source: 'amount', operandField: null, operandValue: null } },
        { id: 'read-regions', kind: 'query', title: '地域マスタを取得',
          config: { source: 'agent-regions', parameters: {}, template: null } },
        { id: 'sum-by-region', kind: 'joinAggregate', title: '地域別に売上を合算',
          inputs: { left: 'amount-number', right: 'read-regions' },
          config: { leftKey: 'region_id', rightKey: 'region_id', groupBy: 'region', metric: 'numeric_amount', operation: 'sum' } },
        { id: 'rank-regions', kind: 'sortLimit', title: '売上順に並べる', input: 'sum-by-region',
          config: { sortBy: 'sum_numeric_amount', direction: 'desc', limit: 10 } },
        { id: 'preview-result', kind: 'preview', title: '集計結果を表示', input: 'rank-regions', config: { limit: 10 } },
      ],
    }
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'exploration', message: '2つのデータ構造を確認します。', changes: [],
        sourceIds: ['agent-sales', 'agent-regions'], reason: '結合列と集計列の型を確認するためです。' })
      .mockResolvedValueOnce({ state: 'proposal', message: '地域別売上を計算するWorkflowを提案します。', changes: ['2つのデータを結合して集計'],
        workflow: proposedWorkflow, plan: {
          summary: '地域別の売上合計を求めます。',
          dataSources: [{ id: 'agent-sales', name: '売上明細' }, { id: 'agent-regions', name: '地域マスタ' }],
          steps: proposedWorkflow.steps.map((step) => ({ title: step.title, description: `${step.title}を実行します。` })),
          warnings: [],
        } })

    const agentResponse = await app.request('/api/agent/respond', {
      method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'multi-source-1', message: '地域別の売上合計を多い順に見せて', workflow: sampleWorkflow }),
    })
    expect(agentResponse.status).toBe(200)
    const proposal = await agentResponse.json() as {
      state: string
      conversationId: string
      workflow: Workflow
      toolCalls: Array<{ tool: string; status: string }>
    }
    expect(proposal).toMatchObject({
      state: 'proposal',
      toolCalls: [
        { tool: 'catalog_explore_personal', status: 'completed' },
        { tool: 'catalog_explore_personal', status: 'completed' },
      ],
    })
    expect(respond).toHaveBeenCalledTimes(2)

    const savedResponse = await app.request('/api/workflows', {
      method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow: proposal.workflow, changeSource: 'agent' }),
    })
    expect(savedResponse.status).toBe(201)
    const saved = await savedResponse.json() as { version: number }
    const runResponse = await app.request(`/api/workflows/${proposal.workflow.id}/runs`, {
      method: 'POST',
      headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: saved.version, conversationId: proposal.conversationId }),
    })
    expect(runResponse.status).toBe(201)
    expect(await runResponse.json()).toMatchObject({ run: {
      status: 'completed',
      finalArtifact: {
        type: 'table',
        rowCount: 2,
        preview: [
          { region: 'East', sum_numeric_amount: 150 },
          { region: 'West', sum_numeric_amount: 80 },
        ],
      },
    } })
    const conversation = await (await app.request(`/api/conversations/${proposal.conversationId}`, {
      headers: admin.headers,
    })).json() as { messages: Array<{ role: string; content: string; metadata?: unknown }> }
    expect(conversation.messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('実行しました'),
      metadata: { type: 'workflow_run', run: { status: 'completed', finalArtifact: { rowCount: 2 } } },
    })
  })

  it('returns an actionable agent availability error without exposing model configuration', async () => {
    const user = await login('agent-error-user')
    vi.spyOn(services.agent, 'respond').mockRejectedValue(new AppError('agent_provider_unreachable', 503,
      '分析エージェントへ接続できません。時間をおいて再度お試しください。', undefined, true))
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'agent-error-1', message: '売上を確認したい', workflow: sampleWorkflow }) })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'agent_provider_unreachable',
      title: '分析エージェントへ接続できません。時間をおいて再度お試しください。',
      detail: '分析エージェントへ接続できません。時間をおいて再度お試しください。' })
  })

  it('returns the OIDC-derived application role in the BFF session', async () => {
    const admin = await login('admin', 'admin')
    const response = await app.request('/auth/session', { headers: { Cookie: admin.headers.Cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ authenticated: true, applicationRole: 'admin' })
  })

  it('persists an agent clarification immediately and restores its structured metadata', async () => {
    const alice = await login('alice')
    vi.spyOn(services.agent, 'respond').mockResolvedValue({ state: 'clarification', message: '対象期間を確認します。', changes: [],
      questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月', '今月'] }] })
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'client-message-1', message: '売上を集計したい', workflow: sampleWorkflow }) })
    expect(response.status).toBe(200)
    const result = await response.json() as { conversationId: string; state: string; provider?: unknown }
    expect(result).not.toHaveProperty('provider')
    expect(result).toMatchObject({ state: 'clarification', conversationId: expect.any(String) })
    const conversation = await (await app.request(`/api/conversations/${result.conversationId}`, { headers: alice.headers })).json()
    expect(conversation).toMatchObject({ title: '売上を集計したい', messages: [
      { role: 'user', content: '売上を集計したい' },
      { role: 'assistant', content: '対象期間を確認します。', metadata: { state: 'clarification', questions: [{ id: 'period' }] } },
    ] })
  })

  it('keeps saved history separate from the latest request passed to the Agent', async () => {
    const alice = await login('history-boundary-user')
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'clarification', message: '対象期間を確認します。', changes: [],
        questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月'] }] })
      .mockResolvedValueOnce({ state: 'answer', message: '先月として続けます。', changes: [], sourceIds: [], reason: '回答を反映' })

    const first = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'history-turn-1', message: '売上を集計したい', workflow: sampleWorkflow }) })
    const { conversationId } = await first.json() as { conversationId: string }
    const second = await app.request('/api/agent/respond', { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, clientMessageId: 'history-turn-2', message: '先月です', workflow: sampleWorkflow }) })

    expect(second.status).toBe(200)
    expect(respond).toHaveBeenCalledTimes(2)
    expect(respond.mock.calls[1]?.[0]).toMatchObject({
      message: '先月です',
      history: [
        { role: 'user', content: '売上を集計したい' },
        { role: 'assistant', content: '対象期間を確認します。' },
      ],
      currentTurn: { events: [] },
    })
    expect(respond.mock.calls[1]?.[0].history).not.toContainEqual(expect.objectContaining({ content: '先月です' }))
    expect(respond.mock.calls[1]?.[0].toolResults).toBeUndefined()
  })

  it('revokes the BFF session and returns the identity-provider logout redirect', async () => {
    const alice = await login('alice')
    vi.spyOn(services.auth, 'endSession').mockResolvedValue(new URL('https://id.example.com/logout?client_id=test'))
    const response = await app.request('/api/auth/logout', { method: 'POST', headers: alice.headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false, redirectUrl: 'https://id.example.com/logout?client_id=test' })
    expect(response.headers.get('set-cookie')).toContain('mmm_session=;')
    expect(await services.sessions.get(alice.headers.Cookie.slice('mmm_session='.length))).toBeUndefined()
  })

  it('archives connections instead of physically deleting their definitions', async () => {
    const alice = await login('alice', 'admin')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(restSourceRegistration) })
    expect((await app.request('/api/data-sources/sample-api', { method: 'DELETE', headers: alice.headers })).status).toBe(200)
    expect(await (await app.request('/api/data-sources', { headers: alice.headers })).json()).toEqual({ sources: [] })
    const stored = await backend.database.query.selectFrom('data_sources').select(['status', 'version']).where('id', '=', 'sample-api').executeTakeFirst()
    expect(stored).toMatchObject({ status: 'archived', version: 2 })
  })

  it('requires a checksum-bound one-time approval for Artifact download and exposes no direct GET link', async () => {
    const alice = await login('alice', 'admin')
    const artifact = await backend.artifacts.createCsv({ ...alice.identity, sessionHash: 'fixture', requestId: 'artifact-create' },
      'report.csv', [{ value: '=1+1' }], ['test'], 'spreadsheet')
    expect((await app.request(`/artifacts/${artifact.id}/download`, { headers: alice.headers })).status).toBe(404)
    const approvalResponse = await app.request(`/api/artifacts/${artifact.id}/download-approvals`, { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: '{}' })
    expect(approvalResponse.status).toBe(201)
    const approval = await approvalResponse.json() as { id: string; summary: { checksum: string } }
    expect(approval.summary.checksum).toBe(artifact.checksum)
    const download = () => app.request(`/api/artifacts/${artifact.id}/download`, { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: approval.id }) })
    expect((await download()).status).toBe(200)
    expect((await download()).status).toBe(403)
  })

  it('binds a CSV-producing Workflow run to a one-time version approval before backend dispatch', async () => {
    const alice = await login('alice', 'admin')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(restSourceRegistration) })
    const workflow = { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, source: 'sample-api' } } : step) }
    const saved = await (await app.request('/api/workflows', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow, changeSource: 'manual' }) })).json() as { version: number }
    const runRequest = (approvalId?: string) => app.request(`/api/workflows/${workflow.id}/runs`, { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: saved.version, approvalId }) })
    expect((await runRequest()).status).toBe(403)
    const approval = await (await app.request(`/api/workflows/${workflow.id}/run-approvals`, { method: 'POST',
      headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: saved.version }) })).json() as { id: string }
    const artifact = { id: 'art-csv', type: 'csv' as const, name: 'result.csv', rowCount: 1, columns: ['value'],
      provenance: ['test'], trustLevel: 'untrusted' as const, classification: 'internal' as const, checksum: 'checksum', createdAt: new Date().toISOString() }
    const mcp = vi.spyOn(services.mcp, 'call')
    vi.spyOn(services.runs, 'execute').mockResolvedValue({ id: 'run-1', workflowId: workflow.id, status: 'completed',
      startedAt: new Date().toISOString(), durationMs: 1, steps: [{ stepId: 'csv', status: 'completed', artifact, durationMs: 1 }], finalArtifact: artifact })
    expect((await runRequest(approval.id)).status).toBe(201)
    expect((await runRequest(approval.id)).status).toBe(403)
    expect(mcp).not.toHaveBeenCalled()
  })
})
