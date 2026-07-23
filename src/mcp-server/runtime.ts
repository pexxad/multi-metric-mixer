import type { McpRuntimeConfig } from '../server/config'
import { SafeHttpClient } from './connectors/safe-http'
import { CloudWatchLogsReadConnector, DynamoDbReadConnector } from './connectors/aws'
import { RestDataSourceService } from './connectors/rest-json'
import { DataSourceReadService } from './connectors/read-service'
import { SqlReadConnector, MongoDbReadConnector } from './connectors/databases'
import { UploadArtifactReadConnector } from './connectors/upload'
import { createDataSourceSecretProvider } from './connectors/source-secrets'
import { McpExecutionGrantStore } from '../server/mcp/execution-grant'
import { ArtifactRepository } from '../server/persistence/artifact-repository'
import { DataSourceRepositoryAdapter } from '../server/persistence/data-source-repository'
import { RunRepository } from '../server/persistence/run-repository'
import { WorkflowRepository } from '../server/persistence/workflow-repository'
import { WorkflowTools } from './tools'
import { WorkflowExecutionService } from './workflow-execution'
import { openApplicationStorage } from '../server/persistence/storage-factory'
import { McpInvocationRepository } from '../server/persistence/mcp-invocation-repository'

export type McpServices = Awaited<ReturnType<typeof createMcpServices>>

export async function createMcpServices(config: McpRuntimeConfig) {
  const storage = await openApplicationStorage(config.storage)
  const database = storage.database
  const sources = new DataSourceRepositoryAdapter(database)
  const artifacts = new ArtifactRepository(database, storage.artifacts, config.limits.artifactStorageBytes, config.limits.artifactRetentionDays)
  const workflows = new WorkflowRepository(database)
  const runs = new RunRepository(database)
  const tools = new WorkflowTools(artifacts, config.limits.joinRows)
  const http = new SafeHttpClient({ timeoutMs: 5_000, maxResponseBytes: config.limits.sourceResponseBytes,
    maxRedirects: 3, maxJsonDepth: config.limits.jsonDepth,
    allowedPrivateHosts: config.sourceNetwork.allowedPrivateHosts, allowedHttpHosts: config.sourceNetwork.allowedHttpHosts })
  const secrets = createDataSourceSecretProvider(config.sourceSecrets)
  const rest = new RestDataSourceService(artifacts, http, config.limits.sourceRows)
  const reader = new DataSourceReadService(sources, {
    'rest-json': rest,
    dynamodb: new DynamoDbReadConnector(artifacts),
    'cloudwatch-logs': new CloudWatchLogsReadConnector(artifacts),
    'upload-artifact': new UploadArtifactReadConnector(artifacts),
    sql: new SqlReadConnector(artifacts, secrets),
    mongodb: new MongoDbReadConnector(artifacts, secrets),
  })
  const execution = new WorkflowExecutionService(workflows, runs, reader, tools)
  const grants = new McpExecutionGrantStore(database, config.mcpServer.grantTtlSeconds)
  const invocations = new McpInvocationRepository(database)
  await Promise.all([database.pruneEphemeral(), artifacts.pruneExpired()])
  return { database, sources, artifacts, workflows, runs, tools, http, rest, secrets, reader, execution, grants, invocations,
    close: () => storage.close() }
}
