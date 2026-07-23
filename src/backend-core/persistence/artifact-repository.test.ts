import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../../shared/request-context'
import { BackendDatabase } from '../../backend-core/persistence/backend-database'
import { ArtifactRepository, spreadsheetFormulaRisk } from './artifact-repository'
import { MemoryArtifactContentStore } from './artifact-content-store'
import { backendContext, testBackendDatabase } from '../../test-support'

describe('ArtifactRepository', () => {
  const databases: BackendDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup(subject = 'alice') {
    const database = await testBackendDatabase(); databases.push(database)
    const context: RequestContext = backendContext({
      sessionHash: `session-${subject}`,
      requestId: `request-${subject}`,
      principal: { id: `principal-${subject}`, displayName: subject, status: 'active' },
      applicationRole: 'user',
    })
    const store = new MemoryArtifactContentStore()
    return { database, context, store, artifacts: new ArtifactRepository(database, store) }
  }

  it('persists untrusted provenance and isolates artifacts by Workspace', async () => {
    const alice = await setup('alice')
    const artifact = await alice.artifacts.createTable(alice.context, 'source-data', [{ category: 'A', value: 10 }], ['source:api'])
    const bob: RequestContext = backendContext({
      sessionHash: 'session-bob',
      requestId: 'request-bob',
      principal: { id: 'principal-bob', displayName: 'Bob', status: 'active' },
      workspace: { id: 'other', name: 'Other', slug: 'other', role: 'editor', membershipVersion: 1 },
      applicationRole: 'user',
    })
    expect(await alice.artifacts.get(alice.context, artifact.id)).toMatchObject({ trustLevel: 'untrusted', checksum: artifact.checksum })
    expect(await alice.artifacts.get(bob, artifact.id)).toBeUndefined()
  })

  it('neutralizes spreadsheet formulas but preserves machine CSV values', async () => {
    const { context, artifacts } = await setup()
    const rows = [
      { value: '=HYPERLINK("https://evil.example")' },
      { value: '＋SUM(A1:A2)' },
      { value: 'safe' },
    ]
    const spreadsheet = await artifacts.createCsv(context, 'safe.csv', rows, [], 'spreadsheet')
    const machine = await artifacts.createCsv(context, 'machine.csv', rows, [], 'machine')
    expect(Buffer.from(spreadsheet.content!).toString('utf8')).toContain("'=HYPERLINK")
    expect(Buffer.from(spreadsheet.content!).toString('utf8')).toContain("'＋SUM")
    expect(Buffer.from(machine.content!).toString('utf8')).not.toContain("'=HYPERLINK")
    expect(spreadsheet.provenance).toContain('csv:neutralized=2')
  })

  it('hides and physically prunes expired artifact content', async () => {
    const { context, database, store } = await setup()
    const repository = new ArtifactRepository(database, store)
    const artifact = await repository.createTable(context, 'expired', [{ value: 1 }], ['test'], { expiresAt: '2000-01-01T00:00:00.000Z' })
    expect(await repository.get(context, artifact.id)).toBeUndefined()
    expect(await repository.pruneExpired()).toBe(1)
    expect(await database.query.selectFrom('artifacts').select('id').where('id', '=', artifact.id).executeTakeFirst()).toBeUndefined()
  })

  it.each(['=1+1', '+cmd', '-1+1', '@SUM(A1)', ' ＋SUM(A1)', '\t=1'])('detects formula prefix %s', (value) => {
    expect(spreadsheetFormulaRisk(value)).toBe(true)
  })
})
