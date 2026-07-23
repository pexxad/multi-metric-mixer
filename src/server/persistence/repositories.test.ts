import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../request-context'
import { sampleWorkflow } from '../../shared/workflow'
import { ApplicationDatabase } from './database'
import { DataSourceRepositoryAdapter } from './data-source-repository'
import { CatalogRepository } from './catalog-repository'
import { IdentityRepository } from './identity-repository'
import { WorkflowRepository } from './workflow-repository'
import { testDatabase } from '../../test-support'

describe('Workspace repositories', () => {
  const databases: ApplicationDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup() {
    const database = await testDatabase(); databases.push(database)
    const identities = new IdentityRepository(database)
    const createContext = async (subject: string, applicationRole: 'admin' | 'user' = 'admin'): Promise<RequestContext> => {
      const identity = await identities.resolve({
        providerKey: 'oidc-main', subject, displayName: subject, groups: [], applicationRole, assuranceLevel: 'basic',
      })
      return { sessionHash: `session-${subject}`, ...identity, requestId: `request-${subject}` }
    }
    const sources = new DataSourceRepositoryAdapter(database)
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
    const { database, createContext, workflows, sources } = await setup()
    const alice = await createContext('alice')
    const bobIdentity = await createContext('bob', 'user')
    const now = new Date().toISOString()
    await database.query.insertInto('workspaces').values({ id: 'other', name: 'Other', slug: 'other', status: 'active',
      created_at: now, updated_at: now }).execute()
    await database.query.insertInto('workspace_memberships').values({ workspace_id: 'other', principal_id: bobIdentity.principal.id,
      role: 'editor', version: 1, created_at: now, updated_at: now }).execute()
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

  it('persists SQL and MongoDB metadata with secret references but no credentials', async () => {
    const { createContext, sources } = await setup()
    const alice = await createContext('alice')
    await sources.register(alice, { id: 'sales', name: 'Sales', type: 'sql', driver: 'postgresql',
      secretId: 'production/postgres', schema: 'public', table: 'sales', maxRows: 100 })
    await sources.register(alice, { id: 'events', name: 'Events', type: 'mongodb', secretId: 'production/mongodb',
      database: 'metrics', collection: 'events', maxDocuments: 100 })
    const registered = await sources.list(alice)
    expect(registered.map((source) => source.type).toSorted()).toEqual(['mongodb', 'sql'])
    expect(JSON.stringify(registered)).not.toContain('connectionString')
    expect(JSON.stringify(registered)).not.toContain('password')
  })

  it('keeps the Workspace canonical Catalog separate from personal changes and can reset or promote them', async () => {
    const { createContext, sources, catalogs } = await setup()
    const admin = await createContext('admin')
    const user = await createContext('alice', 'user')
    await sources.register(admin, { id: 'sales', name: 'Sales', type: 'sql', driver: 'sqlite',
      secretId: 'local/sqlite', table: 'sales', maxRows: 100 })
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
    await sources.register(admin, { id: 'events', name: 'Events', type: 'mongodb', secretId: 'local/mongodb',
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
