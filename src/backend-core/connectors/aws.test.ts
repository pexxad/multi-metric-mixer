import { afterEach, describe, expect, it } from 'vitest'
import { BackendDatabase } from '../persistence/backend-database'
import { ArtifactRepository } from '../persistence/artifact-repository'
import { DynamoDbReadConnector, awsConnectorInternals } from './aws'
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
})
