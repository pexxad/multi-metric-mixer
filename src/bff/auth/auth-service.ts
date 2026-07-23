import type { IdentityRepository } from '../persistence/identity-repository'
import type { AuthenticationProviderRegistry } from './provider'
import type { AuthTransactionStore, SessionService } from './session-service'

export class AuthenticationService {
  constructor(
    readonly providers: AuthenticationProviderRegistry,
    readonly sessions: SessionService,
    private readonly transactions: AuthTransactionStore,
    private readonly identities: IdentityRepository,
  ) {}

  async begin(providerKey: string, returnTo = '/'): Promise<{ transactionToken: string; authorizationUrl: URL }> {
    const provider = this.providers.require(providerKey)
    const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
    const started = await provider.begin(safeReturnTo)
    return { transactionToken: await this.transactions.create(started.transaction), authorizationUrl: started.url }
  }

  async finish(transactionToken: string | undefined, callbackUrl: URL) {
    const transaction = await this.transactions.consume(transactionToken)
    if (!transaction) throw new Error('authentication_transaction_invalid')
    const authenticated = await this.providers.require(transaction.providerKey).finish(callbackUrl, transaction)
    const identity = await this.identities.resolve(authenticated.identity)
    return { ...await this.sessions.create(identity, authenticated.logoutHint), returnTo: transaction.returnTo }
  }

  endSession(providerKey: string, postLogoutRedirectUri: string, logoutHint?: string): Promise<URL> {
    return this.providers.require(providerKey).endSession(postLogoutRedirectUri, logoutHint)
  }
}
