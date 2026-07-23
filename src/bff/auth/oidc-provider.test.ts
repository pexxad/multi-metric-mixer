import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationRoleForGroups, OidcAuthenticationProvider } from './oidc-provider'

const base = { key: 'oidc', label: 'OIDC', clientId: 'client', redirectUri: 'http://localhost:5173/auth/callback',
  scopes: ['openid'], groupsClaim: 'groups', adminGroup: 'multi-metric-mixer-admins', logout: { mode: 'oidc' as const } }

describe('OidcAuthenticationProvider transport policy', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('requires HTTPS by default', () => {
    expect(() => new OidcAuthenticationProvider({ ...base, issuer: 'http://127.0.0.1:8080/realms/local' })).toThrow('HTTPS')
  })

  it('allows an explicitly configured HTTP loopback issuer through library discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      issuer: 'http://127.0.0.1:8080/realms/local',
      authorization_endpoint: 'http://127.0.0.1:8080/realms/local/protocol/openid-connect/auth',
      token_endpoint: 'http://127.0.0.1:8080/realms/local/protocol/openid-connect/token',
      jwks_uri: 'http://127.0.0.1:8080/realms/local/protocol/openid-connect/certs',
    })))
    const provider = new OidcAuthenticationProvider({ ...base, issuer: 'http://127.0.0.1:8080/realms/local',
      allowInsecureLoopback: true })
    await expect(provider.begin('/')).resolves.toMatchObject({ url: expect.any(URL), transaction: { providerKey: 'oidc' } })
  })

  it('never allows insecure remote issuers', () => {
    expect(() => new OidcAuthenticationProvider({ ...base, issuer: 'http://id.example.com',
      allowInsecureLoopback: true })).toThrow('HTTPS')
  })

  it('maps only an exact configured OIDC group to administrator', () => {
    expect(applicationRoleForGroups(['multi-metric-mixer-admins'], base.adminGroup)).toBe('admin')
    expect(applicationRoleForGroups(['multi-metric-mixer-admins-readonly'], base.adminGroup)).toBe('user')
    expect(applicationRoleForGroups([], base.adminGroup)).toBe('user')
  })

  it('uses the discovered RP-Initiated Logout endpoint for standard OIDC providers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      issuer: 'https://id.example.com',
      authorization_endpoint: 'https://id.example.com/authorize',
      token_endpoint: 'https://id.example.com/token',
      jwks_uri: 'https://id.example.com/jwks',
      end_session_endpoint: 'https://id.example.com/logout',
    })))
    const provider = new OidcAuthenticationProvider({ ...base, issuer: 'https://id.example.com' })
    const url = await provider.endSession('https://app.example.com/')
    expect(url.toString()).toBe('https://id.example.com/logout?post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2F&client_id=client')
    expect((await provider.endSession('https://app.example.com/', 'signed-id-token')).searchParams.get('id_token_hint')).toBe('signed-id-token')
    const withoutHint = new OidcAuthenticationProvider({ ...base, issuer: 'https://id.example.com', logout: { mode: 'oidc', useIdTokenHint: false } })
    expect((await withoutHint.endSession('https://app.example.com/', 'stale-id-token')).searchParams.has('id_token_hint')).toBe(false)
  })

  it('uses Cognito managed-login logout without treating the hosted domain as the token issuer', async () => {
    const provider = new OidcAuthenticationProvider({ ...base, issuer: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool',
      logout: { mode: 'cognito', endpoint: 'https://example.auth.ap-northeast-1.amazoncognito.com/logout?ignored=true' } })
    const url = await provider.endSession('https://app.example.com/')
    expect(url.toString()).toBe('https://example.auth.ap-northeast-1.amazoncognito.com/logout?client_id=client&logout_uri=https%3A%2F%2Fapp.example.com%2F')
  })

  it('rejects an insecure Cognito logout endpoint', async () => {
    const provider = new OidcAuthenticationProvider({ ...base, issuer: 'https://id.example.com',
      logout: { mode: 'cognito', endpoint: 'http://id.example.com/logout' } })
    await expect(provider.endSession('https://app.example.com/')).rejects.toThrow('HTTPS')
  })
})
