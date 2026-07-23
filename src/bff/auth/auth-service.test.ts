import { afterEach, describe, expect, it } from 'vitest'
import { BffDatabase } from '../persistence/bff-database'
import { IdentityRepository, type VerifiedIdentity } from '../persistence/identity-repository'
import { AuthenticationService } from './auth-service'
import type { AuthenticationProvider, AuthorizationTransaction } from './provider'
import { AuthenticationProviderRegistry } from './provider'
import { AuthTransactionStore, hashToken, SessionService } from './session-service'
import { testBffDatabase } from '../../test-support'

class FixtureProvider implements AuthenticationProvider {
  readonly key = 'fixture-oidc'
  readonly label = 'Fixture OIDC'
  readonly identity: VerifiedIdentity = {
    providerKey: this.key,
    subject: 'subject-1',
    displayName: 'Alice',
    email: 'alice@example.com',
    groups: ['analysts'],
    applicationRole: 'user',
    assuranceLevel: 'mfa',
  }

  async begin(returnTo: string) {
    return {
      url: new URL('https://id.example.com/authorize?client_id=test'),
      transaction: { providerKey: this.key, state: 'state-secret', nonce: 'nonce-secret', codeVerifier: 'verifier-secret', returnTo },
    }
  }

  async finish(_callbackUrl: URL, transaction: AuthorizationTransaction) {
    if (transaction.state !== 'state-secret') throw new Error('invalid_state')
    return { identity: this.identity, logoutHint: 'fixture-id-token' }
  }

  async endSession(postLogoutRedirectUri: string) {
    return new URL(`/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`, 'https://id.example.com')
  }
}

describe('authentication services', () => {
  const databases: BffDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  async function setup() {
    const database = await testBffDatabase(); databases.push(database)
    const provider = new FixtureProvider()
    const sessions = new SessionService(database, 'session-secret-that-is-at-least-32-characters', 3600)
    const transactions = new AuthTransactionStore(database, 'transaction-secret-that-is-at-least-32-characters')
    const service = new AuthenticationService(
      new AuthenticationProviderRegistry([provider]), sessions, transactions, new IdentityRepository(database),
    )
    return { database, sessions, service }
  }

  it('delegates the protocol flow to a provider and creates a Workspace-bound BFF session', async () => {
    const { database, sessions, service } = await setup()
    const started = await service.begin('fixture-oidc', '//evil.example')
    expect(started.authorizationUrl.origin).toBe('https://id.example.com')
    const finished = await service.finish(started.transactionToken, new URL('https://app.example.com/auth/callback?code=abc&state=state-secret'))
    expect(finished.returnTo).toBe('/')
    expect(finished.identity).toMatchObject({
      principal: { displayName: 'Alice' }, workspace: { role: 'editor' }, applicationRole: 'user', assuranceLevel: 'mfa',
    })
    expect((await sessions.get(finished.token))?.workspace.id).toBe(finished.identity.workspace.id)
    expect(sessions.verifyCsrf(finished.token, finished.csrfToken)).toBe(true)
    expect(sessions.verifyCsrf(finished.token, 'wrong')).toBe(false)
    expect(await sessions.logoutHint(finished.token)).toBe('fixture-id-token')
    const stored = await database.query.selectFrom('auth_sessions').select('logout_hint_ciphertext').executeTakeFirstOrThrow() as {
      logout_hint_ciphertext: string
    }
    expect(stored.logout_hint_ciphertext).not.toContain('fixture-id-token')
  })

  it('stores only hashes and encrypted transaction payloads and consumes transactions once', async () => {
    const { database, service } = await setup()
    const started = await service.begin('fixture-oidc', '/workflows')
    const row = await database.query.selectFrom('auth_transactions').select(['transaction_hash', 'encrypted_payload']).executeTakeFirstOrThrow() as {
      transaction_hash: string; encrypted_payload: string
    }
    expect(row.transaction_hash).toBe(hashToken(started.transactionToken))
    expect(row.encrypted_payload).not.toContain('state-secret')
    await service.finish(started.transactionToken, new URL('https://app.example.com/auth/callback?code=abc&state=state-secret'))
    await expect(service.finish(started.transactionToken, new URL('https://app.example.com/auth/callback')))
      .rejects.toThrow('authentication_transaction_invalid')
  })

  it('revokes BFF sessions without deleting their audit identity', async () => {
    const { sessions, service } = await setup()
    const started = await service.begin('fixture-oidc')
    const finished = await service.finish(started.transactionToken, new URL('https://app.example.com/auth/callback?code=abc&state=state-secret'))
    await sessions.revoke(finished.token)
    expect(await sessions.get(finished.token)).toBeUndefined()
  })

  it('delegates identity-provider logout URL construction to the selected provider', async () => {
    const { service } = await setup()
    const url = await service.endSession('fixture-oidc', 'https://app.example.com/')
    expect(url.origin).toBe('https://id.example.com')
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/')
  })
})
