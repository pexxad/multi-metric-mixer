import { AuthenticationService } from './auth/auth-service'
import { OidcAuthenticationProvider } from './auth/oidc-provider'
import { AuthenticationProviderRegistry } from './auth/provider'
import { AuthTransactionStore, SessionService } from './auth/session-service'
import type { RuntimeConfig } from './config'
import { IdentityRepository } from './persistence/identity-repository'
import { ConversationRepository } from './persistence/conversation-repository'
import { AuditRepository } from './persistence/audit-repository'
import { ApprovalService } from './approval-service'
import { InternalMcpClient } from './internal-mcp-client'
import { InternalBackendApiClient } from './internal-backend-api-client'
import { openBffStorage } from './persistence/bff-storage'
import { AgentService, DisabledAgentModel } from './agent/agent-service'
import { OpenAiCompatibleAgentModel } from './agent/openai-compatible-provider'
import { BackendCapabilityIssuer } from '../shared/backend-capability'

export type BffServices = Awaited<ReturnType<typeof createBffServices>>

export async function createBffServices(config: RuntimeConfig, options: { backendFetch?: typeof fetch } = {}) {
  const storage = await openBffStorage(config.bffStorage)
  const database = storage.database
  const identities = new IdentityRepository(database)
  const sessions = new SessionService(database, config.auth.sessionSecret, config.auth.sessionTtlSeconds)
  const providers = new AuthenticationProviderRegistry([new OidcAuthenticationProvider({
    key: config.auth.providerKey, label: config.auth.oidc.providerLabel, issuer: config.auth.oidc.issuer,
    clientId: config.auth.oidc.clientId, clientSecret: config.auth.oidc.clientSecret,
    redirectUri: config.auth.oidc.redirectUri, scopes: config.auth.oidc.scopes, groupsClaim: config.auth.oidc.groupsClaim,
    adminGroup: config.auth.oidc.adminGroup, logout: config.auth.oidc.logout,
    allowInsecureLoopback: config.auth.oidc.allowInsecureLoopback,
  })])
  const auth = new AuthenticationService(providers, sessions,
    new AuthTransactionStore(database, config.auth.transactionSecret), identities)
  const capabilities = new BackendCapabilityIssuer({
    issuer: config.backendServer.tokenIssuer,
    audience: config.backendServer.audience,
    keyId: config.backendServer.tokenKeyId,
    privateKeyBase64: config.backendServer.tokenPrivateKeyBase64,
    ttlSeconds: config.backendServer.tokenTtlSeconds,
  })
  const backendUrl = new URL(`http://${config.backendServer.hostname}:${config.backendServer.port}`)
  const backend = new InternalBackendApiClient({
    url: backendUrl,
    origin: config.backendServer.origin,
    capabilities,
    fetch: options.backendFetch,
  })
  const mcp = new InternalMcpClient({
    url: new URL('/mcp', backendUrl),
    origin: config.backendServer.origin,
    capabilities,
    fetch: options.backendFetch,
  })
  const conversations = new ConversationRepository(database)
  const agent = new AgentService(config.agent.provider === 'openai-compatible'
    ? new OpenAiCompatibleAgentModel({ baseUrl: new URL(config.agent.baseUrl), model: config.agent.model,
      apiKey: config.agent.apiKey, timeoutMs: config.agent.timeoutMs, maxTokens: config.agent.maxTokens,
      contextWindowTokens: config.agent.contextWindowTokens,
      transportSecurity: config.agent.transportSecurity })
    : new DisabledAgentModel())
  const audit = new AuditRepository(database)
  const approvals = new ApprovalService(database)
  await database.pruneEphemeral()
  return {
    database,
    identities,
    sessions,
    providers,
    auth,
    backend,
    sources: backend.sources,
    catalogs: backend.catalogs,
    artifacts: backend.artifacts,
    workflows: backend.workflows,
    mcp,
    conversations,
    runs: backend.runs,
    audit,
    approvals,
    transfers: backend.transfers,
    agent,
    close: () => storage.close(),
  }
}
