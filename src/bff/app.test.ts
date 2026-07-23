import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicApp } from './app'
import { runtimeConfigSchema, type RuntimeConfig } from './config'
import { createBffServices, type BffServices } from './runtime'
import { sampleWorkflow } from '../shared/workflow'
import { AppError } from '../shared/errors'
import { testCapabilityKeys } from '../test-support'
import { backendRuntimeConfigSchema, type BackendRuntimeConfig } from '../backend-server/config'
import { createBackendCore, type BackendCore } from '../backend-core/runtime'
import { createBackendApp } from '../backend-server/app'

const capabilityKeys = testCapabilityKeys()
const config: RuntimeConfig = runtimeConfigSchema.parse({
  version: 1,
  release: 'test',
  publicServer: { hostname: '127.0.0.1', port: 3000, origin: 'http://localhost:3000', allowedOrigins: ['http://localhost:3000'] },
  backendServer: {
    hostname: '127.0.0.1', port: 3001, origin: 'http://127.0.0.1:3000', audience: 'http://127.0.0.1:3001',
    tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPrivateKeyBase64: capabilityKeys.privateKeyBase64, tokenTtlSeconds: 15,
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
    tokenIssuer: 'test-bff', tokenKeyId: 'test-1', tokenPublicKeyBase64: capabilityKeys.publicKeyBase64,
  },
  backendStorage: { driver: 'sqlite', sqlitePath: ':memory:', artifactPath: '/tmp/multi-metric-mixer-backend-tests' },
  limits: config.limits,
  sourceNetwork: { allowedPrivateHosts: [], allowedHttpHosts: [] },
  sourceSecrets: { provider: 'file', filePath: '/tmp/multi-metric-mixer-test-source-secrets.json' },
})

describe('public Hono BFF', () => {
  let services: BffServices
  let backend: BackendCore
  let app: ReturnType<typeof createPublicApp>

  beforeEach(async () => {
    backend = await createBackendCore(backendConfig)
    const backendApp = createBackendApp(backendConfig, backend)
    const backendFetch: typeof fetch = async (input, init) => backendApp.request(input instanceof URL ? input.toString() : input, init)
    services = await createBffServices(config, { backendFetch })
    app = createPublicApp({ config, services })
  })
  afterEach(async () => {
    await services.close()
    await backend.close()
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
    const bootstrap = await (await app.request('/api/bootstrap', { headers })).json()
    expect(bootstrap).toMatchObject({
      workflows: [{ workflow: { name: 'Second' }, version: 2 }],
      mcp: { tools: 25, dataSourceAccess: 'read-only' },
    })
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
    const registration = { id: 'sample-api', name: 'Sample API', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET' }
    expect((await app.request('/api/data-sources', {
      method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(registration),
    })).status).toBe(403)
    expect((await app.request('/api/data-sources', {
      method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(registration),
    })).status).toBe(201)
    expect(await (await app.request('/api/data-sources', { headers: alice.headers })).json()).toMatchObject({ sources: [{ id: 'sample-api', accessMode: 'read-only' }] })
    expect(await (await app.request('/api/data-sources', { headers: bob.headers })).json()).toMatchObject({ sources: [{ id: 'sample-api' }] })
    expect((await app.request('/api/data-sources/sample-api', { method: 'DELETE', headers: bob.headers })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api/impact', { headers: bob.headers })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api/test', { method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parameters: {} }) })).status).toBe(403)
    expect((await app.request('/api/data-sources/sample-api', { method: 'PATCH', headers: { ...bob.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: registration, expectedVersion: 1 }) })).status).toBe(403)
    expect((await app.request('/api/uploads/json?filename=data.json&sourceId=uploaded&sourceName=Uploaded', {
      method: 'POST', headers: { ...bob.headers, 'Content-Type': 'application/json' }, body: '{}',
    })).status).toBe(403)
  })

  it('lets users keep personal Catalog changes while only administrators can change the Workspace canonical version', async () => {
    const admin = await login('catalog-admin', 'admin')
    const user = await login('catalog-user')
    const registration = { id: 'sales', name: 'Sales', type: 'sql', driver: 'sqlite', secretId: 'local/sqlite', table: 'sales', maxRows: 100 }
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(registration) })
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
      body: JSON.stringify({ id: 'sales', name: 'Sales', type: 'sql', driver: 'sqlite', secretId: 'local/sqlite', table: 'sales', maxRows: 100 }) })
    const observation = { sourceId: 'sales', observedAt: '2026-07-22T00:00:00.000Z', rowCount: 1, sampledRows: 1,
      schemaFingerprint: 'schema-1', fields: [{ path: 'amount', dataTypes: ['number'], nullable: false, presence: 1,
        businessName: '', description: '', unit: '', timezone: '' }] }
    vi.spyOn(services.mcp, 'call').mockImplementation(async (context) => ({
      observation,
      catalog: await backend.catalogs.applyObservation(context, 'sales', observation),
    }))
    const respond = vi.spyOn(services.agent, 'respond')
      .mockResolvedValueOnce({ state: 'exploration', message: '項目を確認します。', changes: [], sourceIds: ['sales'], reason: 'Catalogが未登録です。' })
      .mockResolvedValueOnce({ state: 'clarification', message: '金額の期間を確認します。', changes: [],
        questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月'] }] })
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'explore-1', message: '売上を集計したい', workflow: sampleWorkflow }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'clarification' })
    expect(services.mcp.call).toHaveBeenCalledWith(expect.anything(), 'catalog_explore_personal',
      { source: 'sales', parameters: { limit: '100' } })
    expect(respond).toHaveBeenCalledTimes(2)
    expect(respond.mock.calls[1]?.[0].catalogs).toMatchObject([{ sourceId: 'sales', scope: 'personal',
      definition: { fields: [{ path: 'amount' }] } }])
  })

  it('reads and returns only the bounded sample selected by the Agent', async () => {
    const admin = await login('sample-admin', 'admin')
    const user = await login('sample-user')
    await app.request('/api/data-sources', { method: 'POST', headers: { ...admin.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'sales', name: 'Sales', type: 'sql', driver: 'sqlite', secretId: 'local/sqlite', table: 'sales', maxRows: 100 }) })
    vi.spyOn(services.agent, 'respond').mockResolvedValue({ state: 'sample', message: '形式確認用に3件を表示します。', changes: [],
      sourceIds: ['sales'], limit: 3, reason: 'format inspection' })
    const artifact = { id: 'sample-preview', type: 'table' as const, name: 'sales-preview', rowCount: 3,
      columns: ['category', 'amount'], preview: [{ category: 'Hardware', amount: 1200 }], provenance: ['source:sales'],
      trustLevel: 'untrusted' as const, classification: 'internal' as const, checksum: 'checksum', createdAt: new Date().toISOString() }
    const call = vi.spyOn(services.mcp, 'call')
      .mockResolvedValueOnce({ ...artifact, id: 'sample-read' })
      .mockResolvedValueOnce(artifact)
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'sample-1', message: '実データを3件見せて', workflow: sampleWorkflow }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'sample', limit: 3,
      artifact: { id: 'sample-preview', rowCount: 3, preview: [{ category: 'Hardware', amount: 1200 }] } })
    expect(call).toHaveBeenNthCalledWith(1, expect.anything(), 'data_source_read',
      { source: 'sales', parameters: { limit: '3' } })
    expect(call).toHaveBeenNthCalledWith(2, expect.anything(), 'artifact_preview',
      { artifactId: 'sample-read', config: { limit: 3 } })
  })

  it('returns an actionable model connectivity error instead of a generic internal error', async () => {
    const user = await login('agent-error-user')
    vi.spyOn(services.agent, 'respond').mockRejectedValue(new AppError('agent_provider_unreachable', 503,
      'モデルAPIへ接続できません。接続先と稼働状態を確認してください。', undefined, true))
    const response = await app.request('/api/agent/respond', { method: 'POST', headers: { ...user.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId: 'agent-error-1', message: '売上を確認したい', workflow: sampleWorkflow }) })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'agent_provider_unreachable',
      title: 'モデルAPIへ接続できません。接続先と稼働状態を確認してください。',
      detail: 'モデルAPIへ接続できません。接続先と稼働状態を確認してください。' })
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
    const result = await response.json() as { conversationId: string; state: string }
    expect(result).toMatchObject({ state: 'clarification', conversationId: expect.any(String) })
    const conversation = await (await app.request(`/api/conversations/${result.conversationId}`, { headers: alice.headers })).json()
    expect(conversation).toMatchObject({ title: '売上を集計したい', messages: [
      { role: 'user', content: '売上を集計したい' },
      { role: 'assistant', content: '対象期間を確認します。', metadata: { state: 'clarification', questions: [{ id: 'period' }] } },
    ] })
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
    const registration = { id: 'sample-api', name: 'Sample API', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET' }
    await app.request('/api/data-sources', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(registration) })
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

  it('binds a CSV-producing Workflow run to a one-time version approval before MCP dispatch', async () => {
    const alice = await login('alice', 'admin')
    const registration = { id: 'sample-api', name: 'Sample API', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET' }
    await app.request('/api/data-sources', { method: 'POST', headers: { ...alice.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(registration) })
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
    vi.spyOn(services.mcp, 'call').mockResolvedValue({ id: 'run-1', workflowId: workflow.id, status: 'completed',
      startedAt: new Date().toISOString(), durationMs: 1, steps: [{ stepId: 'csv', status: 'completed', artifact, durationMs: 1 }], finalArtifact: artifact })
    expect((await runRequest(approval.id)).status).toBe(201)
    expect((await runRequest(approval.id)).status).toBe(403)
  })
})
