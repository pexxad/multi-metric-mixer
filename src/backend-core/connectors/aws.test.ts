import { afterEach, describe, expect, it } from 'vitest'
import { BackendDatabase } from '../persistence/backend-database'
import { ArtifactRepository } from '../persistence/artifact-repository'
import { CloudWatchLogsReadConnector, DynamoDbReadConnector, awsConnectorInternals } from './aws'
import type { RequestContext } from '../../shared/request-context'
import { MemoryArtifactContentStore } from '../persistence/artifact-content-store'
import { backendContext, testBackendDatabase } from '../../test-support'

describe('read-only AWS connector boundary', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('normalizes AWS document values without allowing non-finite numbers', () => {
    expect(awsConnectorInternals.jsonValue({ set: new Set(['a']), bytes: new Uint8Array([1, 2]) }))
      .toEqual({ set: ['a'], bytes: 'AQI=' })
    expect(() => awsConnectorInternals.jsonValue(Number.NaN)).toThrow(/有限/)
  })

  it('rejects every operation outside the explicit GetItem/Query/Scan allowlist before calling AWS', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context: RequestContext = backendContext({ requestId: 'request' })
    let calls = 0
    const connector = new DynamoDbReadConnector(new ArtifactRepository(database, new MemoryArtifactContentStore()), () => ({ send: async () => { calls += 1; return {} } }))
    const source = { id: 'dynamo', name: 'Dynamo', type: 'dynamodb' as const, region: 'ap-northeast-1', tableName: 'Metrics',
      partitionKey: 'pk', maxItems: 100, version: 1, accessMode: 'read-only' as const, status: 'active' as const }
    await expect(connector.read(context, source, { source: 'dynamo', parameters: { operation: 'PutItem' } })).rejects.toThrow(/GetItem/)
    expect(calls).toBe(0)
  })

  it('binds a registered Logs query template and returns its declared output model', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const commands: unknown[] = []
    const connector = new CloudWatchLogsReadConnector(new ArtifactRepository(database, new MemoryArtifactContentStore()), () => ({
      send: async (command) => {
        commands.push(command)
        return command.constructor.name === 'StartQueryCommand' ? { queryId: 'query-1' }
          : { status: 'Complete', results: [[{ field: 'service', value: 'payment' }, { field: 'count', value: '12' }]] }
      },
    }))
    const source = { id: 'logs', name: 'Logs', type: 'cloudwatch-logs' as const, region: 'ap-northeast-1',
      logGroupName: '/app/logs', maxResults: 1000, maxRangeSeconds: 604800, queryMode: 'template-required' as const,
      queryTemplates: [{ id: 'errors', name: 'Errors', description: '', outputDataModel: 'table' as const,
        outputFields: ['service', 'count'],
        variables: [
          { id: 'startTime', label: '開始', description: '', required: true, input: 'datetime' as const, type: 'datetime' as const },
          { id: 'endTime', label: '終了', description: '', required: true, input: 'datetime' as const, type: 'datetime' as const },
          { id: 'service', label: 'サービス', description: '', required: true, input: 'select' as const, type: 'string' as const,
            options: [{ value: 'payment', label: '決済' }] },
        ], execution: { kind: 'cloudwatch-logs-insights' as const,
          query: 'fields service | filter service = {{service}} | stats count(*) by service',
          startTimeVariable: 'startTime', endTimeVariable: 'endTime' } }],
      version: 3, accessMode: 'read-only' as const, status: 'active' as const }
    const artifact = await connector.read(backendContext(), source, { source: 'logs', parameters: {}, template: {
      id: 'errors', sourceVersion: 3, arguments: {
        startTime: '2026-07-25T00:00:00Z', endTime: '2026-07-26T00:00:00Z', service: 'payment',
      },
    } })
    expect(artifact).toMatchObject({ type: 'table', rows: [{ service: 'payment', count: '12' }] })
    expect(JSON.stringify(commands[0])).toContain('service = \\"payment\\"')
    expect(artifact.provenance).toContain('query-template:errors')
  })
})
