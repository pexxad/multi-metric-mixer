import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../request-context'
import { SessionService } from '../auth/session-service'
import { ApplicationDatabase } from '../persistence/database'
import { IdentityRepository } from '../persistence/identity-repository'
import { McpExecutionGrantStore } from './execution-grant'
import { testDatabase } from '../../test-support'

describe('McpExecutionGrantStore', () => {
  const databases: ApplicationDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup(ttlSeconds = 30) {
    const database = await testDatabase(); databases.push(database)
    const identity = await new IdentityRepository(database).resolve({
      providerKey: 'oidc-main', subject: 'alice', displayName: 'Alice', groups: [], applicationRole: 'user', assuranceLevel: 'mfa',
    })
    const sessions = new SessionService(database, 'session-secret-that-is-at-least-32-characters', 3600)
    const created = await sessions.create(identity)
    const context: RequestContext = { ...created.identity, requestId: 'request-1' }
    return { database, sessions, token: created.token, context, grants: new McpExecutionGrantStore(database, ttlSeconds) }
  }

  it('consumes a grant atomically exactly once', async () => {
    const { context, grants } = await setup()
    const request = { action: 'data_source_list', inputHash: 'input-hash' }
    const token = await grants.issue(context, request)
    expect(await grants.consume(token, request)).toMatchObject({ principal: { id: context.principal.id }, workspace: { id: context.workspace.id } })
    await expect(grants.consume(token, request)).rejects.toThrow('無効')
  })

  it('allows only one winner when the same grant is consumed concurrently', async () => {
    const { context, grants } = await setup()
    const request = { action: 'workflow_execute', inputHash: 'input-hash', workflowContentHash: 'workflow-hash', approvalId: 'approval-1' }
    const token = await grants.issue(context, request)
    const results = await Promise.allSettled([grants.consume(token, request), grants.consume(token, request)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('binds an export-producing run grant to its one-time approval', async () => {
    const { context, grants } = await setup()
    const request = { action: 'workflow_execute', inputHash: 'input-hash', approvalId: 'approval-1' }
    const token = await grants.issue(context, request)
    await expect(grants.consume(token, { ...request, approvalId: 'approval-2' })).rejects.toThrow('一致しません')
  })

  it('binds the grant to exact action and canonical input hash', async () => {
    const { context, grants } = await setup()
    const token = await grants.issue(context, { action: 'data_source_list', inputHash: 'hash-a' })
    await expect(grants.consume(token, { action: 'rest_api_query', inputHash: 'hash-a' })).rejects.toThrow('一致しません')
  })

  it('invalidates outstanding grants when Workspace membership changes', async () => {
    const { database, context, grants } = await setup()
    const request = { action: 'data_source_list', inputHash: 'input-hash' }
    const token = await grants.issue(context, request)
    await database.query.updateTable('workspace_memberships').set((eb) => ({ version: eb('version', '+', 1) }))
      .where('workspace_id', '=', context.workspace.id).where('principal_id', '=', context.principal.id).execute()
    await expect(grants.consume(token, request)).rejects.toThrow('無効')
  })

  it('invalidates grants when their BFF session is revoked', async () => {
    const { sessions, token: sessionToken, context, grants } = await setup()
    const request = { action: 'data_source_list', inputHash: 'input-hash' }
    const grant = await grants.issue(context, request)
    await sessions.revoke(sessionToken)
    await expect(grants.consume(grant, request)).rejects.toThrow('無効')
  })
})
