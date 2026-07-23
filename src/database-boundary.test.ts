import { Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { testBackendDatabase, testBffDatabase } from './test-support'

async function tableNames(database: { query: Kysely<Record<string, Record<string, unknown>>> }) {
  const result = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`
    .execute(database.query)
  return result.rows.map((row) => row.name)
}

describe('database ownership boundary', () => {
  it('keeps identity, session, and conversation tables exclusively in the BFF database', async () => {
    const bff = await testBffDatabase()
    const backend = await testBackendDatabase()
    try {
      const bffTables = await tableNames(bff)
      const backendTables = await tableNames(backend)
      expect(bffTables).toEqual(expect.arrayContaining(['principals', 'auth_sessions', 'conversations', 'approvals']))
      expect(bffTables).not.toEqual(expect.arrayContaining(['data_sources', 'catalog_versions', 'workflows', 'artifacts']))
      expect(backendTables).not.toEqual(expect.arrayContaining(['principals', 'auth_sessions', 'conversations', 'approvals']))
    } finally {
      await Promise.all([bff.close(), backend.close()])
    }
  })

  it('keeps source, Catalog, Workflow, Run, and Artifact tables exclusively in the Backend database', async () => {
    const bff = await testBffDatabase()
    const backend = await testBackendDatabase()
    try {
      const bffTables = await tableNames(bff)
      const backendTables = await tableNames(backend)
      expect(backendTables).toEqual(expect.arrayContaining([
        'data_sources',
        'catalog_versions',
        'workflows',
        'runs',
        'artifacts',
        'mcp_tool_invocations',
      ]))
      expect(bffTables).not.toEqual(expect.arrayContaining(['data_sources', 'workflows', 'mcp_tool_invocations']))
      expect(backendTables).not.toContain('mcp_execution_grants')
    } finally {
      await Promise.all([bff.close(), backend.close()])
    }
  })
})
