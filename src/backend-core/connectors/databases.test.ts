import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRepository } from '../persistence/artifact-repository'
import { MemoryArtifactContentStore } from '../persistence/artifact-content-store'
import { BackendDatabase } from '../persistence/backend-database'
import { backendContext, testBackendDatabase } from '../../test-support'
import type { DataSource } from '../persistence/data-source-repository'
import { MongoDbReadConnector, SqlReadConnector, databaseConnectorInternals } from './databases'

describe('read-only database connectors', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('reads a registered SQL table through a matching secret without exposing the connection string', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'sql' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const secrets = { resolve: async () => ({ type: 'sql' as const, driver: 'postgresql' as const,
      connectionString: 'postgresql://secret@127.0.0.1/data', tls: { mode: 'disable-loopback' as const } }) }
    const connector = new SqlReadConnector(artifacts, secrets, {
      postgresql: async (_source, _secret, limit) => [{ id: 1, limit }],
      sqlite: async () => [],
    })
    const source = { id: 'sales', name: 'Sales', type: 'sql', driver: 'postgresql', secretId: 'local/postgres',
      schema: 'public', table: 'sales', maxRows: 100, version: 1, accessMode: 'read-only', status: 'active' } satisfies DataSource
    const artifact = await connector.read(context, source, { source: 'sales', parameters: { limit: '5' } })
    expect(artifact.rows).toEqual([{ id: 1, limit: 5 }])
    expect(artifact.provenance.join(' ')).not.toContain('postgresql://')
  })

  it('reads a registered MongoDB collection and rejects arbitrary query parameters', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'mongo' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const secrets = { resolve: async () => ({ type: 'mongodb' as const, connectionString: 'mongodb://127.0.0.1/data' }) }
    const connector = new MongoDbReadConnector(artifacts, secrets, async (_source, _secret, limit) => [{ event: 'created', limit }])
    const source = { id: 'events', name: 'Events', type: 'mongodb', secretId: 'local/mongodb', database: 'metrics',
      collection: 'events', maxDocuments: 100, version: 1, accessMode: 'read-only', status: 'active' } satisfies DataSource
    await expect(connector.read(context, source, { source: 'events', parameters: { filter: '{}' } })).rejects.toThrow('limit以外')
    const artifact = await connector.read(context, source, { source: 'events', parameters: { limit: '3' } })
    expect(artifact.rows).toEqual([{ event: 'created', limit: 3 }])
  })

  it('requires TLS for non-loopback MongoDB URIs', () => {
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://db.example.com/app')).toBe(false)
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://db.example.com/app?tls=true')).toBe(true)
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://127.0.0.1/app')).toBe(true)
  })
})
