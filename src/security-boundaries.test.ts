import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createMcpRequestHandler } from './mcp-server/server'
import { loadMcpRuntimeConfig } from './server/config'
import { testDatabase } from './test-support'
import { IdentityRepository } from './server/persistence/identity-repository'
import { SessionService } from './server/auth/session-service'

describe('Version 1 security boundaries', () => {
  it.each(['GET', 'POST', 'DELETE'])('rejects missing or unexpected MCP Origin for %s before grant handling', async (method) => {
    const handler = createMcpRequestHandler({ expectedHost: '127.0.0.1:3001', expectedOrigin: 'http://127.0.0.1:3000',
      grants: {} as never, invocations: {} as never, dependencies: {} as never })
    expect((await handler(new Request('http://127.0.0.1:3001/mcp', { method,
      headers: { Host: '127.0.0.1:3001' }, ...(method === 'POST' ? { body: '{}' } : {}) }))).status).toBe(403)
    expect((await handler(new Request('http://127.0.0.1:3001/mcp', { method,
      headers: { Host: '127.0.0.1:3001', Origin: 'null' }, ...(method === 'POST' ? { body: '{}' } : {}) }))).status).toBe(403)
  })

  it('contains no external data-source write command or identity fields in MCP tool input', async () => {
    const source = await readFile('src/mcp-server/server.ts', 'utf8')
    const aws = await readFile('src/mcp-server/connectors/aws.ts', 'utf8')
    const databases = await readFile('src/mcp-server/connectors/databases.ts', 'utf8')
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
    expect(() => loadMcpRuntimeConfig({ STORAGE_DRIVER: 'postgres', DATABASE_URL_SECRET_ID: 'db' })).toThrow()
    const database = await testDatabase()
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
