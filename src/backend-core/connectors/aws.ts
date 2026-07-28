import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs'
import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { ArtifactRepository, StoredArtifact } from '../persistence/artifact-repository'
import type { DataSource } from '../persistence/data-source-repository'
import type { JsonValue, QueryStep } from '../../shared/workflow'
import { renderCloudWatchQuery } from '../../shared/query-template'

type DynamoReader = { send(command: GetCommand | QueryCommand | ScanCommand): Promise<Record<string, unknown>> }
type LogsReader = { send(command: StartQueryCommand | GetQueryResultsCommand | StopQueryCommand): Promise<Record<string, unknown>> }

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new AppError('source_json_depth', 413, 'AWSレスポンスのネストが深すぎます。')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AppError('source_non_finite_number', 400, '有限でない数値は扱えません。')
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (value instanceof Set) return [...value].map((item) => jsonValue(item, depth + 1))
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)]))
  return String(value)
}

function asDocuments(items: unknown[], max: number): JsonValue[] {
  if (items.length > max) throw new AppError('source_row_limit', 413, `AWSレスポンスが最大行数${max}を超えました。`)
  return items.map((item) => jsonValue(item))
}

export class DynamoDbReadConnector {
  constructor(private readonly artifacts: ArtifactRepository, private readonly clientFactory: (region: string) => DynamoReader = (region) =>
    DynamoDBDocumentClient.from(new DynamoDBClient({ region }))) {}

  async read(context: RequestContext, source: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (source.type !== 'dynamodb') throw new AppError('source_type_mismatch', 400, 'DynamoDB readerにはDynamoDB接続が必要です。')
    const operation = config.parameters.operation ?? 'Scan'
    const client = this.clientFactory(source.region)
    let response: Record<string, unknown>
    if (operation === 'GetItem') {
      const partitionValue = config.parameters.partitionValue
      if (!partitionValue) throw new AppError('dynamodb_key_required', 400, 'GetItemにはpartitionValueが必要です。')
      const Key: Record<string, string> = { [source.partitionKey]: partitionValue }
      if (source.sortKey) {
        const sortValue = config.parameters.sortValue
        if (!sortValue) throw new AppError('dynamodb_key_required', 400, 'sortValueが必要です。')
        Key[source.sortKey] = sortValue
      }
      response = await client.send(new GetCommand({ TableName: source.tableName, Key, ConsistentRead: false }))
    } else if (operation === 'Query') {
      const partitionValue = config.parameters.partitionValue
      if (!partitionValue) throw new AppError('dynamodb_key_required', 400, 'QueryにはpartitionValueが必要です。')
      response = await client.send(new QueryCommand({ TableName: source.tableName, Limit: source.maxItems,
        KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': source.partitionKey },
        ExpressionAttributeValues: { ':pk': partitionValue }, ConsistentRead: false }))
    } else if (operation === 'Scan') {
      response = await client.send(new ScanCommand({ TableName: source.tableName, Limit: source.maxItems, ConsistentRead: false }))
    } else throw new AppError('dynamodb_operation_denied', 400, '許可される操作はGetItem、Query、Scanだけです。')
    const items = operation === 'GetItem' ? (response.Item ? [response.Item] : []) : (response.Items as unknown[] | undefined) ?? []
    return this.artifacts.createDocuments(context, `${source.id}-response`, asDocuments(items, source.maxItems),
      [`source:${source.id}@${source.version}`, 'trust:untrusted', 'transport:dynamodb', `operation:${operation}`, `table:${source.tableName}`], { runId })
  }
}

const terminal = new Set(['Complete', 'Failed', 'Cancelled', 'Timeout', 'Unknown'])

export class CloudWatchLogsReadConnector {
  constructor(private readonly artifacts: ArtifactRepository, private readonly clientFactory: (region: string) => LogsReader = (region) => new CloudWatchLogsClient({ region }), private readonly pollLimit = 30) {}

  async read(context: RequestContext, source: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (source.type !== 'cloudwatch-logs') throw new AppError('source_type_mismatch', 400, 'CloudWatch Logs readerにはCloudWatch Logs接続が必要です。')
    const template = config.template ? source.queryTemplates.find((item) => item.id === config.template!.id) : undefined
    const rendered = template && config.template ? renderCloudWatchQuery(template, config.template.arguments) : undefined
    const queryString = rendered?.query ?? config.parameters.query
    if (!queryString || queryString.length > 4_096) throw new AppError('logs_query_invalid', 400, 'CloudWatch Logs Insights queryが必要です。')
    const endTime = rendered?.endTime ?? Number(config.parameters.endTime ?? Math.floor(Date.now() / 1000))
    const startTime = rendered?.startTime ?? Number(config.parameters.startTime ?? endTime - 3600)
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime <= startTime || endTime - startTime > source.maxRangeSeconds) {
      throw new AppError('logs_time_range_invalid', 400, '検索期間が不正または接続の上限を超えています。')
    }
    const client = this.clientFactory(source.region)
    const started = await client.send(new StartQueryCommand({ logGroupName: source.logGroupName, queryString, startTime, endTime, limit: source.maxResults }))
    const queryId = started.queryId as string | undefined
    if (!queryId) throw new AppError('logs_query_start_failed', 502, 'CloudWatch Logs queryを開始できませんでした。')
    for (let attempt = 0; attempt < this.pollLimit; attempt += 1) {
      const result = await client.send(new GetQueryResultsCommand({ queryId }))
      if (result.status === 'Complete') {
        const rows = ((result.results as Array<Array<{ field?: string; value?: string }>> | undefined) ?? [])
          .map((row) => Object.fromEntries(row.filter((field) => field.field).map((field) => [field.field!, field.value ?? ''])))
        const provenance = [`source:${source.id}@${source.version}`, 'trust:untrusted', 'transport:cloudwatch-logs',
          `range:${startTime}-${endTime}`, ...(template ? [`query-template:${template.id}`] : [])]
        return template?.outputDataModel === 'table'
          ? this.artifacts.createTable(context, `${source.id}-response`, rows, provenance, { runId })
          : this.artifacts.createDocuments(context, `${source.id}-response`, asDocuments(rows, source.maxResults), provenance, { runId })
      }
      if (terminal.has(String(result.status))) throw new AppError('logs_query_failed', 502, `CloudWatch Logs queryは${String(result.status)}で終了しました。`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await client.send(new StopQueryCommand({ queryId })).catch(() => undefined)
    throw new AppError('logs_query_timeout', 504, 'CloudWatch Logs queryが時間内に完了しませんでした。')
  }
}

export const awsConnectorInternals = { jsonValue, asDocuments }
