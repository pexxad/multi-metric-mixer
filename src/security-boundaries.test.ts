import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadBackendRuntimeConfig } from './backend-server/config'
import { testBffDatabase } from './test-support'
import { IdentityRepository } from './bff/persistence/identity-repository'
import { SessionService } from './bff/auth/session-service'

describe('Version 1 security boundaries', () => {
  it('contains no external data-source write command or identity fields in MCP tool input', async () => {
    const source = await readFile('src/backend-server/mcp-adapter.ts', 'utf8')
    const aws = await readFile('src/backend-core/connectors/aws.ts', 'utf8')
    const databases = await readFile('src/backend-core/connectors/databases.ts', 'utf8')
    for (const forbidden of ['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWrite', 'PutLogEvents']) {
      expect(aws).not.toContain(forbidden)
    }
    for (const forbidden of ['principalId:', 'workspaceId:', 'assuranceLevel:']) expect(source).not.toContain(forbidden)
    expect(databases).not.toContain('.insertOne(')
    expect(databases).not.toContain('.updateOne(')
    expect(databases).not.toContain('.deleteOne(')
    expect(databases).not.toContain('FOR UPDATE')
  })

  it('fails closed for incomplete production storage and rotates BFF sessions', async () => {
    expect(() => loadBackendRuntimeConfig({ BACKEND_STORAGE_DRIVER: 'postgres', BACKEND_DATABASE_URL_SECRET_ID: 'db' })).toThrow()
    const database = await testBffDatabase()
    try {
      const identity = await new IdentityRepository(database).resolve({ providerKey: 'oidc', subject: 'alice',
        displayName: 'Alice', groups: [], applicationRole: 'user', assuranceLevel: 'basic' })
      const sessions = new SessionService(database, '01234567890123456789012345678901', 3600)
      const first = await sessions.create(identity)
      const rotated = await sessions.rotate(first.token)
      expect(rotated?.token).not.toBe(first.token)
      expect(await sessions.get(first.token)).toBeUndefined()
      expect((await sessions.get(rotated?.token))?.principal.id).toBe(identity.principal.id)
    } finally { await database.close() }
  })

})
