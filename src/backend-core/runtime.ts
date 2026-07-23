import type { BackendCoreConfig } from '../shared/backend-runtime-config'
import { SafeHttpClient } from './connectors/safe-http'
import { CloudWatchLogsReadConnector, DynamoDbReadConnector } from './connectors/aws'
import { RestDataSourceService } from './connectors/rest-json'
import { DataSourceReadService } from './connectors/read-service'
import { SqlReadConnector, MongoDbReadConnector } from './connectors/databases'
import { UploadArtifactReadConnector } from './connectors/upload'
import { createDataSourceSecretProvider } from './connectors/source-secrets'
import { ArtifactRepository } from './persistence/artifact-repository'
import { DataSourceQueryRepository } from './persistence/data-source-repository'
import { CatalogRepository } from './persistence/catalog-repository'
import { RunRepository } from './persistence/run-repository'
import { WorkflowRepository } from './persistence/workflow-repository'
import { McpInvocationRepository } from './persistence/mcp-invocation-repository'
import { WorkflowTools } from './workflow-tools'
import { WorkflowExecutionService } from './workflow-execution'
import { WorkflowTransferService } from './workflow-transfer'
import { UploadIngestionService } from './upload-ingestion'
import { RunLimitService } from './run-limit-service'
import { openBackendStorage } from './persistence/backend-storage'

export type BackendCore = Awaited<ReturnType<typeof createBackendCore>>

export async function createBackendCore(config: BackendCoreConfig) {
  const storage = await openBackendStorage(config.backendStorage)
  const database = storage.database
  const sourceRepository = new DataSourceQueryRepository(database)
  const sources = {
    get: sourceRepository.get.bind(sourceRepository),
    list: sourceRepository.list.bind(sourceRepository),
  }
  const catalogs = new CatalogRepository(database, sources)
  const artifacts = new ArtifactRepository(
    database,
    storage.artifacts,
    config.limits.artifactStorageBytes,
    config.limits.artifactRetentionDays,
  )
  const workflows = new WorkflowRepository(database)
  const runs = new RunRepository(database)
  const runLimits = new RunLimitService(database, config.limits.concurrentRunsPerWorkspace)
  const tools = new WorkflowTools(artifacts, config.limits.joinRows)
  const http = new SafeHttpClient({
    timeoutMs: 5_000,
    maxResponseBytes: config.limits.sourceResponseBytes,
    maxRedirects: 3,
    maxJsonDepth: config.limits.jsonDepth,
    allowedPrivateHosts: config.sourceNetwork.allowedPrivateHosts,
    allowedHttpHosts: config.sourceNetwork.allowedHttpHosts,
  })
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
  const execution = new WorkflowExecutionService(workflows, runs, reader, tools, runLimits)
  const invocations = new McpInvocationRepository(database)
  const transfers = new WorkflowTransferService(workflows)
  const uploads = new UploadIngestionService(artifacts, storage.artifacts, {
    maxBytes: config.limits.uploadBytes,
    maxRows: config.limits.sourceRows,
    maxColumns: 200,
    maxFieldChars: 100_000,
    maxDepth: config.limits.jsonDepth,
    maxParseMs: 5_000,
    maxJsonNodes: 100_000,
    maxJsonKeys: 10_000,
  })
  await Promise.all([database.pruneEphemeral(), artifacts.pruneExpired()])
  return {
    database,
    sources,
    catalogs,
    artifacts,
    workflows,
    runs,
    runLimits,
    tools,
    http,
    rest,
    secrets,
    reader,
    execution,
    invocations,
    transfers,
    uploads,
    close: () => storage.close(),
  }
}
