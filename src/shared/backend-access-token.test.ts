import { afterEach, describe, expect, it, vi } from 'vitest'
import { backendContext, testBackendAccessTokenKeys } from '../test-support'
import { BackendAccessTokenIssuer, BackendAccessTokenVerifier } from './backend-access-token'

function fixture(verifierAudience = 'http://127.0.0.1:3001') {
  const keys = testBackendAccessTokenKeys()
  const common = { issuer: 'test-bff', audience: 'http://127.0.0.1:3001', keyId: 'test-1' }
  return {
    issuer: new BackendAccessTokenIssuer({
      ...common,
      privateKeyBase64: keys.privateKeyBase64,
      ttlSeconds: 15,
    }),
    verifier: new BackendAccessTokenVerifier({
      ...common,
      audience: verifierAudience,
      publicKeyBase64: keys.publicKeyBase64,
    }),
  }
}

describe('BFF to Backend signed access token', () => {
  const scopes = ['backend:mcp']
  afterEach(() => vi.restoreAllMocks())

  it('reconstructs the opaque principal and Workspace context without consulting the BFF database', async () => {
    const { issuer, verifier } = fixture()
    const context = backendContext()
    const verified = await verifier.verify(await issuer.issue(context, scopes), scopes, 'request-1')
    expect(verified).toMatchObject({
      principal: { id: context.principal.id },
      workspace: { id: context.workspace.id, role: context.workspace.role },
      applicationRole: context.applicationRole,
      accessTokenId: expect.any(String),
      requestId: 'request-1',
    })
  })

  it('requires the intended Backend audience and declared scopes', async () => {
    const { issuer, verifier } = fixture()
    const token = await issuer.issue(backendContext(), scopes)
    await expect(verifier.verify(token, ['connections:admin'], 'request-1')).rejects.toThrow(/権限/)
    const wrongAudience = fixture('http://127.0.0.1:3002')
    await expect(wrongAudience.verifier.verify(
      await wrongAudience.issuer.issue(backendContext(), scopes),
      scopes,
      'request-1',
    )).rejects.toThrow(/claim/)
  })

  it('rejects an expired access token', async () => {
    const issuedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt)
    const { issuer, verifier } = fixture()
    const token = await issuer.issue(backendContext(), scopes)
    clock.mockReturnValue(issuedAt + 20_000)
    await expect(verifier.verify(token, scopes, 'request-1')).rejects.toThrow(/失効/)
  })

  it('allows the same short-lived access token across multiple Backend requests', async () => {
    const { issuer, verifier } = fixture()
    const token = await issuer.issue(backendContext(), scopes)
    expect((await verifier.verify(token, scopes, 'request-1')).requestId).toBe('request-1')
    expect((await verifier.verify(token, scopes, 'request-2')).requestId).toBe('request-2')
  })

  it('rejects a token signed by an untrusted BFF key', async () => {
    const trusted = fixture()
    const untrusted = fixture()
    const token = await untrusted.issuer.issue(backendContext(), scopes)
    await expect(trusted.verifier.verify(token, scopes, 'request-1')).rejects.toThrow(/署名/)
  })

  it('normalizes malformed untrusted tokens to a forbidden access-token error', async () => {
    const { verifier } = fixture()
    await expect(verifier.verify('not-json.payload.signature', scopes, 'request-1')).rejects.toThrow(/不正/)
  })
})
