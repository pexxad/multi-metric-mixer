import type { VerifiedIdentity } from '../persistence/identity-repository'

export type AuthorizationTransaction = {
  providerKey: string
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
}

export type AuthorizationStart = {
  url: URL
  transaction: AuthorizationTransaction
}

export type ProviderAuthenticationResult = {
  identity: VerifiedIdentity
  logoutHint?: string
}

export interface AuthenticationProvider {
  readonly key: string
  readonly label: string
  begin(returnTo: string): Promise<AuthorizationStart>
  finish(callbackUrl: URL, transaction: AuthorizationTransaction): Promise<ProviderAuthenticationResult>
  endSession(postLogoutRedirectUri: string, logoutHint?: string): Promise<URL>
}

export class AuthenticationProviderRegistry {
  private readonly providers = new Map<string, AuthenticationProvider>()

  constructor(providers: AuthenticationProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.key)) throw new Error(`Duplicate authentication provider: ${provider.key}`)
      this.providers.set(provider.key, provider)
    }
    if (this.providers.size === 0) throw new Error('At least one authentication provider is required.')
  }

  require(key: string): AuthenticationProvider {
    const provider = this.providers.get(key)
    if (!provider) throw new Error('authentication_provider_not_enabled')
    return provider
  }

  publicMetadata(): Array<{ key: string; label: string }> {
    return [...this.providers.values()].map(({ key, label }) => ({ key, label }))
  }
}
