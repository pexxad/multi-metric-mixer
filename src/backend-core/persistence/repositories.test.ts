import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../../shared/request-context'
import { sampleWorkflow } from '../../shared/workflow'
import { BackendDatabase } from '../../backend-core/persistence/backend-database'
import { DataSourceQueryRepository } from './data-source-repository'
import { DataSourceAdminService } from '../../backend-server/data-source-admin-service'
import { CatalogRepository } from './catalog-repository'
import { WorkflowRepository } from './workflow-repository'
import { backendContext, testBackendDatabase } from '../../test-support'

describe('Workspace repositories', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup() {
    const database = await testBackendDatabase(); databases.push(database)
    const createContext = async (subject: string, applicationRole: 'admin' | 'user' = 'admin'): Promise<RequestContext> => {
      return backendContext({
        sessionHash: `session-${subject}`,
        requestId: `request-${subject}`,
        principal: { id: `principal-${subject}`, displayName: subject, status: 'active' },
        applicationRole,
      })
    }
    const sourceQueries = new DataSourceQueryRepository(database)
    const profiles = { listPublic: async () => [], resolve: async (id: string) => id === 'db-c'
      ? { id, displayName: 'DB C', dataModel: 'documents' as const, uri: 'mongodb://127.0.0.1/metrics', deniedDatasets: [] }
      : { id, displayName: 'DB A', dataModel: 'table' as const, uri: 'sqlite:///tmp/test.db', deniedDatasets: ['private.*'] } }
    const sourceAdmin = new DataSourceAdminService(database, profiles)
    const sources = {
      get: sourceQueries.get.bind(sourceQueries),
      getVersion: sourceQueries.getVersion.bind(sourceQueries),
      list: sourceQueries.list.bind(sourceQueries),
      register: sourceAdmin.register.bind(sourceAdmin),
      update: sourceAdmin.update.bind(sourceAdmin),
      archive: sourceAdmin.archive.bind(sourceAdmin),
    }
    return { database, createContext, workflows: new WorkflowRepository(database), sources,
      catalogs: new CatalogRepository(database, sources) }
  }

  it('persists immutable Workflow versions and avoids duplicate versions for identical content', async () => {
    const { createContext, workflows } = await setup()
    const alice = await createContext('alice')
    const first = await workflows.save(alice, sampleWorkflow, 'manual')
    const duplicate = await workflows.save(alice, sampleWorkflow, 'manual')
    const changed = await workflows.save(alice, { ...sampleWorkflow, name: 'Renamed Workflow' }, 'agent')
    expect(first.version).toBe(1)
    expect(duplicate.version).toBe(1)
    expect(changed.version).toBe(2)
    expect((await workflows.require(alice, sampleWorkflow.id, 1)).workflow.name).toBe(sampleWorkflow.name)
    expect((await workflows.require(alice, sampleWorkflow.id)).workflow.name).toBe('Renamed Workflow')
  })

  it('stores incomplete graph definitions as Draft while preserving validation errors', async () => {
    const { createContext, workflows } = await setup()
    const alice = await createContext('alice')
    const draft = await workflows.save(alice, {
      ...sampleWorkflow,
      steps: sampleWorkflow.steps.map((step) => step.kind === 'preview' ? { ...step, input: null } : step),
    }, 'manual')
    expect(draft.status).toBe('draft')
    expect(draft.validation.valid).toBe(false)
    expect(draft.validation.errors.join(' ')).toContain('接続されていません')
  })

  it('archives a Workflow without deleting its immutable version history', async () => {
    const { database, createContext, workflows } = await setup()
    const alice = await createContext('alice')
    const saved = await workflows.save(alice, sampleWorkflow, 'manual')
    expect(await workflows.archive(alice, sampleWorkflow.id, saved.version)).toBe(true)
    expect(await workflows.list(alice)).toEqual([])
    await expect(workflows.require(alice, sampleWorkflow.id)).rejects.toThrow('Workflowが見つかりません')
    await expect(workflows.save(alice, { ...sampleWorkflow, name: '復元を試みる' }, 'manual', saved.version))
      .rejects.toThrow('削除済みのWorkflowは更新できません')
    expect(await database.query.selectFrom('workflow_versions').selectAll().where('workflow_id', '=', sampleWorkflow.id).execute()).toHaveLength(1)
  })

  it('isolates connections and Workflows by Workspace rather than caller-provided IDs', async () => {
    const { createContext, workflows, sources } = await setup()
    const alice = await createContext('alice')
    const bobIdentity = await createContext('bob', 'user')
    const bob: RequestContext = { ...bobIdentity,
      workspace: { id: 'other', name: 'Other', slug: 'other', role: 'editor', membershipVersion: 1 } }
    await sources.register(alice, {
      id: 'sample-api', name: 'Sample API', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET',
    })
    await workflows.save(alice, sampleWorkflow, 'manual')
    expect(await sources.list(bob)).toEqual([])
    await expect(workflows.require(bob, sampleWorkflow.id)).rejects.toThrow('Workflowが見つかりません')
  })

  it('denies connection mutation to a non-admin user', async () => {
    const { createContext, sources } = await setup()
    const alice = await createContext('alice')
    const user = { ...alice, applicationRole: 'user' as const }
    await expect(sources.register(user, {
      id: 'sample-api', name: 'Sample API', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET',
    })).rejects.toThrow('管理者だけが変更できます')
  })

  it('rejects configured and built-in database namespaces before persistence', async () => {
    const { createContext, sources } = await setup()
    const admin = await createContext('admin')
    await expect(sources.register(admin, { id: 'private-data', name: 'Private', type: 'database-table',
      connectionId: 'db-a', schema: 'private', table: 'payroll', maxRows: 100 })).rejects.toThrow('登録できません')
    await expect(sources.register(admin, { id: 'system-data', name: 'System', type: 'database-documents',
      connectionId: 'db-c', database: 'admin', collection: 'users', maxDocuments: 100 })).rejects.toThrow('登録できません')
  })

  it('persists logical database targets without credentials or implementation details', async () => {
    const { createContext, sources } = await setup()
    const alice = await createContext('alice')
    await sources.register(alice, { id: 'sales', name: 'Sales', type: 'database-table', connectionId: 'db-a',
      schema: 'public', table: 'sales', maxRows: 100 })
    await sources.register(alice, { id: 'events', name: 'Events', type: 'database-documents', connectionId: 'db-c',
      database: 'metrics', collection: 'events', maxDocuments: 100 })
    const registered = await sources.list(alice)
    expect(registered.map((source) => source.type).toSorted()).toEqual(['database-documents', 'database-table'])
    expect(JSON.stringify(registered)).not.toContain('uri')
    expect(JSON.stringify(registered)).not.toContain('password')
  })

  it('resolves the immutable data-source version pinned by a Workflow query template', async () => {
    const { createContext, sources } = await setup()
    const admin = await createContext('admin')
    const first = await sources.register(admin, { id: 'logs', name: 'Logs', type: 'cloudwatch-logs',
      region: 'ap-northeast-1', logGroupName: '/app/logs', maxResults: 1000, maxRangeSeconds: 604800,
      queryMode: 'template-required', queryTemplates: [{ id: 'errors', name: 'Errors v1', description: '',
        outputDataModel: 'documents', variables: [
          { id: 'startTime', label: '開始', input: 'datetime', type: 'datetime', required: true },
          { id: 'endTime', label: '終了', input: 'datetime', type: 'datetime', required: true },
        ], execution: { kind: 'cloudwatch-logs-insights', query: 'fields @message',
          startTimeVariable: 'startTime', endTimeVariable: 'endTime' } }] })
    if (first.type !== 'cloudwatch-logs') throw new Error('unexpected source type')
    const { version: _version, accessMode: _accessMode, status: _status, ...firstDefinition } = first
    await sources.update(admin, 'logs', { ...firstDefinition, name: 'Logs', queryTemplates: [{
      ...first.queryTemplates[0]!, name: 'Errors v2',
    }] }, 1)
    expect(await sources.getVersion(admin, 'logs', 1)).toMatchObject({
      version: 1, queryTemplates: [{ name: 'Errors v1' }],
    })
    expect(await sources.get(admin, 'logs')).toMatchObject({
      version: 2, queryTemplates: [{ name: 'Errors v2' }],
    })
  })

  it('keeps the Workspace canonical Catalog separate from personal changes and can reset or promote them', async () => {
    const { createContext, sources, catalogs } = await setup()
    const admin = await createContext('admin')
    const user = await createContext('alice', 'user')
    await sources.register(admin, { id: 'sales', name: 'Sales', type: 'database-table', connectionId: 'db-a',
      table: 'sales', maxRows: 100 })
    const base = { sourceId: 'sales', displayName: '売上', description: '', policy: 'curated' as const,
      classification: 'confidential' as const, defaultTimeField: null, relationships: [],
      fields: [{ path: 'amount', dataTypes: ['number' as const], nullable: false, presence: 1,
        businessName: '金額', description: '', unit: 'JPY', timezone: '' }] }
    const canonical = await catalogs.saveCanonical(admin, 'sales', base)
    const personal = await catalogs.savePersonal(user, 'sales', { ...base, displayName: '自分用売上', classification: 'internal' })
    expect(personal).toMatchObject({ scope: 'personal', version: 1, baseCanonicalVersion: canonical.version,
      definition: { displayName: '自分用売上', classification: 'confidential' } })
    expect((await catalogs.bundle(user, 'sales')).effective?.id).toBe(personal.id)

    const reset = await catalogs.resetPersonal(user, 'sales')
    expect(reset.personal).toBeUndefined()
    expect(reset.effective?.id).toBe(canonical.id)
    const recreated = await catalogs.savePersonal(user, 'sales', { ...base, displayName: '再作成した自分用売上' })
    expect(recreated).toMatchObject({ scope: 'personal', version: 2, definition: { displayName: '再作成した自分用売上' } })
    await expect(catalogs.saveCanonical(user, 'sales', base)).rejects.toThrow('管理者だけ')

    const adminPersonal = await catalogs.savePersonal(admin, 'sales', { ...base, displayName: '確認済み売上' })
    const promoted = await catalogs.promotePersonal(admin, 'sales', canonical.version)
    expect(promoted).toMatchObject({ scope: 'canonical', version: 2, changeSource: 'promotion',
      definition: { displayName: adminPersonal.definition.displayName } })
  })

  it('merges variable-schema observations without losing human annotations or previously observed fields', async () => {
    const { createContext, sources, catalogs } = await setup()
    const admin = await createContext('admin')
    const user = await createContext('analyst', 'user')
    await sources.register(admin, { id: 'events', name: 'Events', type: 'database-documents', connectionId: 'db-c',
      database: 'metrics', collection: 'events', maxDocuments: 100 })
    await catalogs.saveCanonical(admin, 'events', { sourceId: 'events', displayName: 'イベント', description: '', policy: 'evolving',
      classification: 'internal', defaultTimeField: null, relationships: [], fields: [
        { path: 'legacy', dataTypes: ['string'], nullable: false, presence: 1, businessName: '旧項目', description: '業務注釈', unit: '', timezone: '' },
      ] })
    const observed = await catalogs.applyObservation(user, 'events', { sourceId: 'events', observedAt: '2026-07-22T00:00:00.000Z',
      rowCount: 2, sampledRows: 2, schemaFingerprint: 'observed', fields: [
        { path: 'current', dataTypes: ['number'], nullable: false, presence: 1, businessName: '', description: '', unit: '', timezone: '' },
      ] })
    expect(observed.definition.fields).toMatchObject([
      { path: 'current', presence: 1 },
      { path: 'legacy', businessName: '旧項目', description: '業務注釈', presence: 0, nullable: true },
    ])
  })
})
