import { ApplicationDatabase } from './server/persistence/database'
import { IdentityRepository, type VerifiedIdentity } from './server/persistence/identity-repository'
import type { RequestContext } from './server/request-context'

const testIdentity: VerifiedIdentity = {
  providerKey: 'test-oidc', subject: 'alice', displayName: 'Alice', email: 'alice@example.com', groups: [],
  applicationRole: 'admin', assuranceLevel: 'basic',
}

export async function testDatabase(): Promise<ApplicationDatabase> {
  return ApplicationDatabase.open({ kind: 'sqlite', filename: ':memory:' })
}

export async function testContext(database: ApplicationDatabase, requestId = 'req_test', identity = testIdentity): Promise<RequestContext> {
  return { ...await new IdentityRepository(database).resolve(identity), sessionHash: `fixture_${identity.subject}`, requestId }
}
