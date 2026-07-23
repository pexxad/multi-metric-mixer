import { afterEach, describe, expect, it } from 'vitest'
import type { RequestContext } from '../request-context'
import { ApplicationDatabase } from './database'
import { ArtifactRepository, spreadsheetFormulaRisk } from './artifact-repository'
import { IdentityRepository } from './identity-repository'
import { MemoryArtifactContentStore } from './artifact-content-store'
import { testDatabase } from '../../test-support'

describe('ArtifactRepository', () => {
  const databases: ApplicationDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup(subject = 'alice') {
    const database = await testDatabase(); databases.push(database)
    const identity = await new IdentityRepository(database).resolve({
      providerKey: 'oidc-main', subject, displayName: subject, groups: [], applicationRole: 'user', assuranceLevel: 'basic',
    })
    const context: RequestContext = { sessionHash: `session-${subject}`, ...identity, requestId: `request-${subject}` }
    const store = new MemoryArtifactContentStore()
    return { database, context, store, artifacts: new ArtifactRepository(database, store) }
  }

  it('persists untrusted provenance and isolates artifacts by Workspace', async () => {
    const alice = await setup('alice')
    const artifact = await alice.artifacts.createTable(alice.context, 'source-data', [{ category: 'A', value: 10 }], ['source:api'])
    const bobIdentity = await new IdentityRepository(alice.database).resolve({
      providerKey: 'oidc-main', subject: 'bob', displayName: 'Bob', groups: [], applicationRole: 'user', assuranceLevel: 'basic',
    })
    const now = new Date().toISOString()
    await alice.database.query.insertInto('workspaces').values({ id: 'other', name: 'Other', slug: 'other', status: 'active',
      created_at: now, updated_at: now }).execute()
    await alice.database.query.insertInto('workspace_memberships').values({ workspace_id: 'other', principal_id: bobIdentity.principal.id,
      role: 'editor', version: 1, created_at: now, updated_at: now }).execute()
    const bob: RequestContext = { sessionHash: 'session-bob', ...bobIdentity,
      workspace: { id: 'other', name: 'Other', slug: 'other', role: 'editor', membershipVersion: 1 }, requestId: 'request-bob' }
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
