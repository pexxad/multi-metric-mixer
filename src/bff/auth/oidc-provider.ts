import * as oidc from 'openid-client'
import type { AssuranceLevel } from '../persistence/identity-repository'
import type { AuthenticationProvider, AuthorizationStart, AuthorizationTransaction, ProviderAuthenticationResult } from './provider'

export type OidcProviderOptions = {
  key: string
  label: string
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes: string[]
  groupsClaim: string
  adminGroup: string
  logout: { mode: 'oidc'; useIdTokenHint?: boolean } | { mode: 'cognito'; endpoint: string }
  allowInsecureLoopback?: boolean
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function applicationRoleForGroups(groups: string[], adminGroup: string): 'admin' | 'user' {
  return groups.includes(adminGroup) ? 'admin' : 'user'
}

function assuranceFromClaims(claims: Record<string, unknown>): AssuranceLevel {
  const amr = strings(claims.amr)
  if (amr.some((value) => ['hwk', 'fido', 'fido2', 'webauthn'].includes(value.toLowerCase()))) return 'strong'
  if (amr.some((value) => ['mfa', 'otp', 'sms'].includes(value.toLowerCase()))) return 'mfa'
  const acr = typeof claims.acr === 'string' ? claims.acr.toLowerCase() : ''
  return acr.includes('mfa') || acr.includes('aal2') ? 'mfa' : 'basic'
}

export class OidcAuthenticationProvider implements AuthenticationProvider {
  readonly key: string
  readonly label: string
  private configuration?: Promise<oidc.Configuration>
  private readonly insecureLoopback: boolean

  constructor(private readonly options: OidcProviderOptions) {
    const issuer = new URL(options.issuer)
    const allowedLoopback = options.allowInsecureLoopback && issuer.protocol === 'http:' && isLoopback(issuer.hostname)
    if (issuer.protocol !== 'https:' && !allowedLoopback) {
      throw new Error('OIDC issuer must use HTTPS unless explicit HTTP loopback access is enabled.')
    }
    this.key = options.key
    this.label = options.label
    this.insecureLoopback = Boolean(allowedLoopback)
  }

  private config(): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(
      new URL(this.options.issuer),
      this.options.clientId,
      this.options.clientSecret ? { client_secret: this.options.clientSecret } : undefined,
      this.options.clientSecret ? oidc.ClientSecretBasic(this.options.clientSecret) : oidc.None(),
      { timeout: 10, ...(this.insecureLoopback ? { execute: [oidc.allowInsecureRequests] } : {}) },
    )
    return this.configuration
  }

  async begin(returnTo: string): Promise<AuthorizationStart> {
    const configuration = await this.config()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.options.redirectUri,
      scope: this.options.scopes.join(' '),
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    })
    return { url, transaction: { providerKey: this.key, state, nonce, codeVerifier, returnTo } }
  }

  async finish(callbackUrl: URL, transaction: AuthorizationTransaction): Promise<ProviderAuthenticationResult> {
    if (transaction.providerKey !== this.key) throw new Error('authentication_provider_mismatch')
    const tokens = await oidc.authorizationCodeGrant(await this.config(), callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    })
    const claims = tokens.claims() as Record<string, unknown> | undefined
    if (!claims || typeof claims.sub !== 'string') throw new Error('oidc_subject_missing')
    const email = typeof claims.email === 'string' ? claims.email : undefined
    const displayName = [claims.name, claims.preferred_username, email, claims.sub]
      .find((value): value is string => typeof value === 'string' && value.length > 0)!
    const configuredGroups = strings(claims[this.options.groupsClaim])
    const cognitoGroups = this.options.groupsClaim === 'cognito:groups' ? [] : strings(claims['cognito:groups'])
    const groups = [...new Set([...configuredGroups, ...cognitoGroups])]
    return { identity: {
      providerKey: this.key,
      subject: claims.sub,
      displayName,
      email,
      groups,
      applicationRole: applicationRoleForGroups(groups, this.options.adminGroup),
      assuranceLevel: assuranceFromClaims(claims),
    }, logoutHint: this.options.logout.mode === 'oidc' && this.options.logout.useIdTokenHint !== false ? tokens.id_token : undefined }
  }

  async endSession(postLogoutRedirectUri: string, logoutHint?: string): Promise<URL> {
    if (this.options.logout.mode === 'cognito') {
      const url = new URL(this.options.logout.endpoint)
      if (url.protocol !== 'https:') throw new Error('Cognito logout endpoint must use HTTPS.')
      url.search = ''
      url.searchParams.set('client_id', this.options.clientId)
      url.searchParams.set('logout_uri', postLogoutRedirectUri)
      return url
    }
    return oidc.buildEndSessionUrl(await this.config(), {
      post_logout_redirect_uri: postLogoutRedirectUri,
      ...(logoutHint && this.options.logout.useIdTokenHint !== false ? { id_token_hint: logoutHint } : {}),
    })
  }
}
