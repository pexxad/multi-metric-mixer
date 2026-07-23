import { AuthenticationService } from '../server/auth/auth-service'
import { OidcAuthenticationProvider } from '../server/auth/oidc-provider'
import { AuthenticationProviderRegistry } from '../server/auth/provider'
import { AuthTransactionStore, SessionService } from '../server/auth/session-service'
import type { RuntimeConfig } from './config'
import { McpExecutionGrantStore } from '../server/mcp/execution-grant'
import { ArtifactRepository } from '../server/persistence/artifact-repository'
import { DataSourceRepositoryAdapter } from '../server/persistence/data-source-repository'
import { IdentityRepository } from '../server/persistence/identity-repository'
import { WorkflowRepository } from '../server/persistence/workflow-repository'
import { ConversationRepository } from '../server/persistence/conversation-repository'
import { AuditRepository } from '../server/persistence/audit-repository'
import { ApprovalService } from '../server/approval-service'
import { WorkflowTransferService } from '../server/workflow-transfer'
import { UploadIngestionService } from '../server/upload-ingestion'
import { InternalMcpClient } from './internal-mcp-client'
import { openApplicationStorage } from '../server/persistence/storage-factory'
import { RunRepository } from '../server/persistence/run-repository'
import { RunLimitService } from '../server/run-limit-service'
import { CatalogRepository } from '../server/persistence/catalog-repository'
import { AgentService, DisabledAgentModel } from '../server/agent/agent-service'
import { OpenAiCompatibleAgentModel } from '../server/agent/openai-compatible-provider'

export type BffServices = Awaited<ReturnType<typeof createBffServices>>

export async function createBffServices(config: RuntimeConfig) {
  const storage = await openApplicationStorage(config.storage)
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
  const sources = new DataSourceRepositoryAdapter(database)
  const catalogs = new CatalogRepository(database, sources)
  const artifacts = new ArtifactRepository(database, storage.artifacts, config.limits.artifactStorageBytes, config.limits.artifactRetentionDays)
  const workflows = new WorkflowRepository(database)
  const grants = new McpExecutionGrantStore(database, config.mcpServer.grantTtlSeconds)
  const mcp = new InternalMcpClient({ url: new URL(`http://${config.mcpServer.hostname}:${config.mcpServer.port}/mcp`),
    origin: config.mcpServer.origin, grants })
  const conversations = new ConversationRepository(database)
  const runs = new RunRepository(database)
  const runLimits = new RunLimitService(database, config.limits.concurrentRunsPerWorkspace)
  const agent = new AgentService(config.agent.provider === 'openai-compatible'
    ? new OpenAiCompatibleAgentModel({ baseUrl: new URL(config.agent.baseUrl), model: config.agent.model,
      apiKey: config.agent.apiKey, timeoutMs: config.agent.timeoutMs, maxTokens: config.agent.maxTokens,
      contextWindowTokens: config.agent.contextWindowTokens,
      transportSecurity: config.agent.transportSecurity })
    : new DisabledAgentModel())
  const audit = new AuditRepository(database)
  const approvals = new ApprovalService(database)
  const transfers = new WorkflowTransferService(workflows)
  const uploads = new UploadIngestionService(artifacts, storage.artifacts, { maxBytes: config.limits.uploadBytes,
    maxRows: config.limits.sourceRows, maxColumns: 200, maxFieldChars: 100_000,
    maxDepth: config.limits.jsonDepth, maxParseMs: 5_000, maxJsonNodes: 100_000, maxJsonKeys: 10_000 })
  await Promise.all([database.pruneEphemeral(), artifacts.pruneExpired()])
  return { database, identities, sessions, providers, auth, sources, catalogs, artifacts, workflows, grants, mcp,
    conversations, runs, runLimits, audit, approvals, transfers, uploads, agent, close: () => storage.close() }
}
