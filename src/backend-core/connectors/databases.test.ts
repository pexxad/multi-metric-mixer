import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactRepository } from '../persistence/artifact-repository'
import { MemoryArtifactContentStore } from '../persistence/artifact-content-store'
import { BackendDatabase } from '../persistence/backend-database'
import { backendContext, testBackendDatabase } from '../../test-support'
import type { DataSource } from '../persistence/data-source-repository'
import { DocumentDatabaseReadConnector, TableDatabaseReadConnector, databaseConnectorInternals } from './databases'

describe('read-only database connectors', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('reads a registered table through a matching connection profile without exposing its URI', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'sql' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const profiles = { listPublic: async () => [], resolve: async () => ({ id: 'db-a', displayName: 'DB A', dataModel: 'table' as const,
      uri: 'postgresql://reader@127.0.0.1/data', tls: { mode: 'disable-loopback' as const }, deniedDatasets: [] }) }
    const connector = new TableDatabaseReadConnector(artifacts, profiles, {
      postgresql: async (_source, _secret, limit) => [{ id: 1, limit }],
      sqlite: async () => [],
    })
    const source = { id: 'sales', name: 'Sales', type: 'database-table', connectionId: 'db-a',
      schema: 'public', table: 'sales', maxRows: 100, version: 1, accessMode: 'read-only', status: 'active' } satisfies DataSource
    const artifact = await connector.read(context, source, { source: 'sales', parameters: { limit: '5' } })
    expect(artifact.rows).toEqual([{ id: 1, limit: 5 }])
    expect(artifact.provenance.join(' ')).not.toContain('postgresql://')
  })

  it('reads a registered MongoDB collection and rejects arbitrary query parameters', async () => {
    const database = await testBackendDatabase(); databases.push(database)
    const context = backendContext({ requestId: 'mongo' })
    const artifacts = new ArtifactRepository(database, new MemoryArtifactContentStore())
    const profiles = { listPublic: async () => [], resolve: async () => ({ id: 'db-c', displayName: 'DB C', dataModel: 'documents' as const,
      uri: 'mongodb://127.0.0.1/data', deniedDatasets: [] }) }
    const connector = new DocumentDatabaseReadConnector(artifacts, profiles, async (_source, _profile, limit) => [{ event: 'created', limit }])
    const source = { id: 'events', name: 'Events', type: 'database-documents', connectionId: 'db-c', database: 'metrics',
      collection: 'events', maxDocuments: 100, version: 1, accessMode: 'read-only', status: 'active' } satisfies DataSource
    await expect(connector.read(context, source, { source: 'events', parameters: { filter: '{}' } })).rejects.toThrow('limit以外')
    const artifact = await connector.read(context, source, { source: 'events', parameters: { limit: '3' } })
    expect(artifact).toMatchObject({ type: 'documents', documents: [{ event: 'created', limit: 3 }] })
  })

  it('requires TLS for non-loopback MongoDB URIs', () => {
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://db.example.com/app')).toBe(false)
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://db.example.com/app?tls=true')).toBe(true)
    expect(databaseConnectorInternals.mongodbTransportAllowed('mongodb://127.0.0.1/app')).toBe(true)
  })

  it('rejects nested SQL values instead of silently treating JSON or arrays as table cells', () => {
    expect(() => databaseConnectorInternals.sqlTableRows([{ id: 1, payload: { region: 'east' } }]))
      .toThrow('スカラー列へ変換')
    expect(() => databaseConnectorInternals.sqlTableRows([{ id: 1, tags: ['a'] }]))
      .toThrow('スカラー列へ変換')
  })
})
