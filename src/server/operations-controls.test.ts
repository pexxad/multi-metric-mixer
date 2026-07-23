import { afterEach, describe, expect, it } from 'vitest'
import { testContext, testDatabase } from '../test-support'
import type { ApplicationDatabase } from './persistence/database'
import { AuditRepository } from './persistence/audit-repository'
import { RunLimitService } from './run-limit-service'

describe('Version 1 operational controls', () => {
  const databases: ApplicationDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('redacts credential and content fields from structured audit events', async () => {
    const database = await testDatabase(); databases.push(database)
    const context = await testContext(database)
    await new AuditRepository(database).record(context, { type: 'test.event', outcome: 'denied', reasonCode: 'policy',
      summary: { count: 2, authorization: 'Bearer secret', rawContent: 'private-data', label: 'safe\r\nvalue' } })
    const row = await database.query.selectFrom('audit_events').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({ request_id: context.requestId, principal_id: context.principal.id, workspace_id: context.workspace.id })
    expect(JSON.parse(String(row.summary_json))).toEqual({ count: 2, label: 'safe  value' })
    expect(JSON.stringify(row)).not.toContain('Bearer secret')
    expect(JSON.stringify(row)).not.toContain('private-data')
  })

  it('enforces and releases the Workspace concurrent-run lease limit', async () => {
    const database = await testDatabase(); databases.push(database)
    const first = await testContext(database, 'run-1')
    const second = { ...first, requestId: 'run-2' }
    const third = { ...first, requestId: 'run-3' }
    const limits = new RunLimitService(database, 2)
    expect(await limits.acquire(first)).toBe(1)
    expect(await limits.acquire(second)).toBe(2)
    await expect(limits.acquire(third)).rejects.toThrow(/同時実行数/)
    await limits.release(first, 1)
    expect(await limits.acquire(third)).toBe(1)
  })
})
