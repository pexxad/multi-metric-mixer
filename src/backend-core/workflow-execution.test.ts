import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../shared/request-context'
import { RestDataSourceService } from './connectors/rest-json'
import { DataSourceReadService } from './connectors/read-service'
import { SafeHttpClient, type HttpTransport } from './connectors/safe-http'
import { BackendDatabase } from '../backend-core/persistence/backend-database'
import { ArtifactRepository } from './persistence/artifact-repository'
import { DataSourceQueryRepository } from './persistence/data-source-repository'
import { DataSourceAdminService } from '../backend-server/data-source-admin-service'
import { RunRepository } from './persistence/run-repository'
import { WorkflowRepository } from './persistence/workflow-repository'
import { WorkflowExecutionService } from './workflow-execution'
import { WorkflowTools } from './workflow-tools'
import { sampleWorkflow } from '../shared/workflow'
import { MemoryArtifactContentStore } from './persistence/artifact-content-store'
import { backendContext, testBackendDatabase } from '../test-support'
import { RunLimitService } from './run-limit-service'

describe('WorkflowExecutionService', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('executes an immutable saved version and persists Run and Artifacts', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context: RequestContext = backendContext({ requestId: 'request' })
    const sources = new DataSourceQueryRepository(database)
    await new DataSourceAdminService(database).register(context, {
      id: 'sample-api', name: 'Sample', type: 'rest-json', baseUrl: 'https://api.example.com', path: '/data', method: 'GET',
    })
    const payload = JSON.stringify([{ category: 'A', value: 10 }, { category: 'A', value: 20 }])
    const transport: HttpTransport = async () => ({ status: 200, contentType: 'application/json', body: payload, byteLength: Buffer.byteLength(payload) })
    const http = new SafeHttpClient({ timeoutMs: 1000, maxResponseBytes: 4096, maxRedirects: 2, maxJsonDepth: 16,
      resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const workflows = new WorkflowRepository(database)
    const saved = await workflows.save(context, { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, source: 'sample-api' } } : step) }, 'manual')
    const rest = new RestDataSourceService(artifacts, http, 100)
    const reader = new DataSourceReadService(sources, { 'rest-json': rest })
    const execution = new WorkflowExecutionService(workflows, new RunRepository(database), reader,
      new WorkflowTools(artifacts), new RunLimitService(database, 2))
    const run = await execution.execute(context, saved.workflow.id, saved.version)
    expect(run.status).toBe('completed')
    expect(run.steps).toHaveLength(3)
    expect(run.finalArtifact.type).toBe('csv')
    expect(await database.query.selectFrom('runs').select('status').where('id', '=', run.id).executeTakeFirst()).toMatchObject({ status: 'completed' })
  })

  it('rejects a join before materializing rows beyond the configured cardinality budget', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'join-limit' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const left = await artifacts.createTable(context, 'left', [{ key: 'x', amount: 1 }, { key: 'x', amount: 2 }], ['test'])
    const right = await artifacts.createTable(context, 'right', [{ key: 'x', group: 'A' }, { key: 'x', group: 'B' }], ['test'])
    const tools = new WorkflowTools(artifacts, 3)
    await expect(tools.joinAggregate(context, left.id, right.id, { leftKey: 'key', rightKey: 'key', groupBy: 'group',
      metric: 'amount', operation: 'sum' })).rejects.toThrow(/上限3行/)
    const unmatched = await artifacts.createTable(context, 'unmatched', [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }], ['test'])
    await expect(tools.join(context, unmatched.id, right.id, { leftKey: 'key', rightKey: 'key', joinType: 'left' }))
      .rejects.toThrow(/上限3行/)
  })

  it('applies the bounded v1 transform tools without executing arbitrary expressions', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'transforms' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const tools = new WorkflowTools(artifacts)
    const sales = await artifacts.createTable(context, 'sales', [
      { regionId: 1, amount: '10', state: 'open' },
      { regionId: 1, amount: '5', state: 'closed' },
      { regionId: 2, amount: '20', state: 'open' },
    ], ['test'])
    const regions = await artifacts.createTable(context, 'regions', [
      { id: 1, region: 'East' }, { id: 2, region: 'West' },
    ], ['test'])

    const filtered = await tools.filterSelect(context, sales.id, {
      columns: ['regionId', 'amount'], filters: [{ field: 'state', operator: 'eq', value: 'open' }],
    })
    const derived = await tools.derive(context, filtered.id, {
      output: 'numericAmount', operation: 'toNumber', source: 'amount', operandField: null, operandValue: null,
    })
    const joined = await tools.join(context, derived.id, regions.id, {
      leftKey: 'regionId', rightKey: 'id', joinType: 'inner',
    })
    const aggregated = await tools.aggregate(context, joined.id, {
      groupBy: 'region', metric: 'numericAmount', operation: 'sum',
    })
    const sorted = await tools.sortLimit(context, aggregated.id, { sortBy: 'sum_numericAmount', direction: 'desc', limit: 1 })

    expect(sorted.rows).toEqual([{ region: 'West', sum_numericAmount: 20 }])
    expect(sorted.provenance).toContain('limit:1')
  })
})
