import type { BackendCoreConfig } from '../shared/backend-runtime-config'
import { SafeHttpClient } from './connectors/safe-http'
import { CloudWatchLogsReadConnector, DynamoDbReadConnector } from './connectors/aws'
import { RestDataSourceService } from './connectors/rest-json'
import { DataSourceReadService } from './connectors/read-service'
import { TableDatabaseReadConnector, DocumentDatabaseReadConnector } from './connectors/databases'
import { UploadArtifactReadConnector } from './connectors/upload'
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
import type { DatabaseConnectionResolver } from './connectors/databases'
import { CatalogExplorationService } from './catalog-exploration'

export type BackendCore = Awaited<ReturnType<typeof createBackendCore>>

export async function createBackendCore(config: BackendCoreConfig, dependencies: {
  databaseConnections: DatabaseConnectionResolver
}) {
  const storage = await openBackendStorage(config.backendStorage)
  const database = storage.database
  const sourceRepository = new DataSourceQueryRepository(database)
  const sources = {
    get: sourceRepository.get.bind(sourceRepository),
    getVersion: sourceRepository.getVersion.bind(sourceRepository),
    list: sourceRepository.list.bind(sourceRepository),
  }
  const catalogs = new CatalogRepository(database, sources)
  const artifacts = new ArtifactRepository(
    database,
    storage.artifacts,
    config.limits.artifactStorageBytes,
    config.limits.artifactRetentionDays,
  )
  const workflows = new WorkflowRepository(database, sources)
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
  const rest = new RestDataSourceService(artifacts, http, config.limits.sourceRows)
  const reader = new DataSourceReadService(sources, {
    'rest-json': rest,
    dynamodb: new DynamoDbReadConnector(artifacts),
    'cloudwatch-logs': new CloudWatchLogsReadConnector(artifacts),
    'upload-artifact': new UploadArtifactReadConnector(artifacts),
    'database-table': new TableDatabaseReadConnector(artifacts, dependencies.databaseConnections),
    'database-documents': new DocumentDatabaseReadConnector(artifacts, dependencies.databaseConnections),
  })
  const execution = new WorkflowExecutionService(workflows, runs, reader, tools, runLimits)
  const exploration = new CatalogExplorationService(reader, catalogs)
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
    reader,
    execution,
    exploration,
    invocations,
    transfers,
    uploads,
    close: () => storage.close(),
  }
}
