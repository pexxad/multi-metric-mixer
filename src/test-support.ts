import { generateKeyPairSync } from 'node:crypto'
import { BffDatabase } from './bff/persistence/bff-database'
import { BackendDatabase } from './backend-core/persistence/backend-database'
import { IdentityRepository, type VerifiedIdentity } from './bff/persistence/identity-repository'
import type { RequestContext } from './shared/request-context'

export const testIdentity: VerifiedIdentity = {
  providerKey: 'test-oidc',
  subject: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  groups: [],
  applicationRole: 'admin',
  assuranceLevel: 'basic',
}

export async function testBffDatabase(): Promise<BffDatabase> {
  return BffDatabase.open({ kind: 'sqlite', filename: ':memory:' })
}

export async function testBackendDatabase(): Promise<BackendDatabase> {
  return BackendDatabase.open({ kind: 'sqlite', filename: ':memory:' })
}

export async function testContext(
  database: BffDatabase,
  requestId = 'req_test',
  identity = testIdentity,
): Promise<RequestContext> {
  return { ...await new IdentityRepository(database).resolve(identity), sessionHash: `fixture_${identity.subject}`, requestId }
}

export function backendContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    sessionHash: 'fixture_alice',
    requestId: 'req_backend',
    principal: { id: 'principal-alice', displayName: 'Alice', status: 'active' },
    workspace: { id: 'main', name: 'Main Workspace', slug: 'main', role: 'editor', membershipVersion: 1 },
    applicationRole: 'admin',
    assuranceLevel: 'basic',
    ...overrides,
  }
}

export function testBackendAccessTokenKeys() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKeyBase64: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}
