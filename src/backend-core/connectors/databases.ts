import BetterSqlite3 from 'better-sqlite3'
import { MongoClient } from 'mongodb'
import { Pool, types as defaultPgTypes } from 'pg'
import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { ArtifactRepository, StoredArtifact } from '../persistence/artifact-repository'
import type { DataSource } from '../persistence/data-source-repository'
import type { JsonValue, QueryStep, TableRow } from '../../shared/workflow'
type TableDatabaseSource = Extract<DataSource, { type: 'database-table' }>
type DocumentDatabaseSource = Extract<DataSource, { type: 'database-documents' }>
type TableProfile = {
  dataModel: 'table'
  uri: string
  tls?: { mode: 'verify-full'; caCertificate?: string } | { mode: 'disable-loopback' }
}
type DocumentProfile = { dataModel: 'documents'; uri: string }
export type DatabaseConnectionProfile = TableProfile | DocumentProfile
export interface DatabaseConnectionResolver {
  resolve(id: string, expectedModel: 'table' | 'documents'): Promise<DatabaseConnectionProfile>
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function requestedLimit(parameters: Record<string, string>, configured: number): number {
  const unknown = Object.keys(parameters).filter((key) => key !== 'limit')
  if (unknown.length) throw new AppError('database_parameter_denied', 400, 'データベースではlimit以外の実行時parameterを指定できません。')
  if (!parameters.limit) return configured
  const value = Number(parameters.limit)
  if (!Number.isInteger(value) || value < 1) throw new AppError('database_limit_invalid', 400, 'limitは1以上の整数で指定してください。')
  return Math.min(value, configured)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new AppError('source_json_depth', 413, 'データベース値のネストが深すぎます。')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AppError('source_non_finite_number', 400, '有限でない数値は扱えません。')
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const bson = value as { _bsontype?: string; toHexString?: () => string; toString(): string }
    if (bson._bsontype && typeof bson.toHexString === 'function') return bson.toHexString()
    if (bson._bsontype && ['Decimal128', 'Long', 'Int32', 'Double', 'Timestamp'].includes(bson._bsontype)) return bson.toString()
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1)]))
  }
  return String(value)
}

function tableRows(rows: Array<Record<string, unknown>>): TableRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonValue(value)])))
}

function sqlTableRows(rows: Array<Record<string, unknown>>): TableRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return [key, value]
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new AppError('sql_column_type_unsupported', 400, `SQL列「${key}」に有限でない数値があります。`)
      return [key, value]
    }
    if (typeof value === 'bigint') return [key, value.toString()]
    if (value instanceof Date) return [key, value.toISOString()]
    throw new AppError('sql_column_type_unsupported', 400,
      `SQL列「${key}」はJSON、配列、複合型またはバイナリです。スカラー列へ変換するか接続対象から除外してください。`)
  })))
}

async function readPostgresql(source: TableDatabaseSource, profile: TableProfile, limit: number): Promise<TableRow[]> {
  const url = new URL(profile.uri)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new AppError('connection_profile_invalid', 500, '表形式DBの接続URIが不正です。')
  let ssl: false | { rejectUnauthorized: true; ca?: string }
  if (profile.tls?.mode === 'disable-loopback') {
    if (!isLoopback(url.hostname)) throw new AppError('sql_tls_required', 500, 'loopback以外のPostgreSQL接続にはTLS検証が必要です。')
    ssl = false
  } else ssl = { rejectUnauthorized: true, ...(profile.tls?.caCertificate ? { ca: profile.tls.caCertificate } : {}) }
  const pool = new Pool({ connectionString: profile.uri, max: 2, ssl, types: {
    getTypeParser(oid, format) {
      if (format !== 'binary' && oid === 20) return (value: string) => {
        const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : value
      }
      if (format !== 'binary' && oid === 1700) return (value: string) => {
        const parsed = Number(value); return Number.isFinite(parsed) ? parsed : value
      }
      return defaultPgTypes.getTypeParser(oid, format)
    },
  } })
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const qualified = source.schema
      ? `${quoteIdentifier(source.schema)}.${quoteIdentifier(source.table)}` : quoteIdentifier(source.table)
    const result = await client.query<Record<string, unknown>>(`SELECT * FROM ${qualified} LIMIT $1`, [limit])
    await client.query('COMMIT')
    return sqlTableRows(result.rows)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function readSqlite(source: TableDatabaseSource, profile: TableProfile, limit: number): Promise<TableRow[]> {
  const url = new URL(profile.uri)
  if (url.protocol !== 'sqlite:') throw new AppError('connection_profile_invalid', 500, '表形式DBの接続URIが不正です。')
  const database = new BetterSqlite3(decodeURIComponent(url.pathname), { readonly: true, fileMustExist: true })
  try {
    database.pragma('query_only = ON')
    const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(source.table)} LIMIT ?`).all(limit) as Array<Record<string, unknown>>
    return sqlTableRows(rows)
  } finally { database.close() }
}

function mongodbTransportAllowed(connectionString: string): boolean {
  if (connectionString.startsWith('mongodb+srv://')) return true
  if (!connectionString.startsWith('mongodb://')) return false
  const [authorityAndPath, query = ''] = connectionString.slice('mongodb://'.length).split('?', 2)
  const authority = authorityAndPath!.split('/', 1)[0]!.split('@').at(-1)!
  const hosts = authority.split(',').map((host) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':', 1)[0]!)
  if (hosts.every(isLoopback)) return true
  const parameters = new URLSearchParams(query)
  return parameters.get('tls') === 'true' || parameters.get('ssl') === 'true'
}

async function readMongo(source: DocumentDatabaseSource, profile: DocumentProfile, limit: number): Promise<TableRow[]> {
  if (!mongodbTransportAllowed(profile.uri)) {
    throw new AppError('mongodb_tls_required', 500, 'loopback以外のMongoDB接続にはTLSが必要です。')
  }
  const client = new MongoClient(profile.uri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 2 })
  try {
    await client.connect()
    const rows = await client.db(source.database).collection(source.collection).find({}, { maxTimeMS: 5_000 }).limit(limit).toArray()
    return tableRows(rows)
  } finally { await client.close() }
}

export class TableDatabaseReadConnector {
  constructor(private readonly artifacts: ArtifactRepository, private readonly profiles: DatabaseConnectionResolver,
    private readonly readers = { postgresql: readPostgresql, sqlite: readSqlite }) {}

  async read(context: RequestContext, dataSource: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (dataSource.type !== 'database-table') throw new AppError('source_type_mismatch', 400, '表形式DB readerには表形式DB接続が必要です。')
    const profile = await this.profiles.resolve(dataSource.connectionId, 'table') as TableProfile
    const limit = requestedLimit(config.parameters, dataSource.maxRows)
    let rows: TableRow[]
    try {
      const protocol = new URL(profile.uri).protocol
      rows = protocol === 'postgres:' || protocol === 'postgresql:'
        ? await this.readers.postgresql(dataSource, profile, limit)
        : await this.readers.sqlite(dataSource, profile, limit)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('database_table_read_failed', 502, '表形式データソースを読み取れませんでした。管理者へ確認してください。')
    }
    return this.artifacts.createTable(context, `${dataSource.id}-response`, rows, [
      `source:${dataSource.id}@${dataSource.version}`, 'trust:untrusted', 'transport:database-table',
      `table:${dataSource.schema ? `${dataSource.schema}.` : ''}${dataSource.table}`, `limit:${limit}`,
    ], { runId })
  }
}

export class DocumentDatabaseReadConnector {
  constructor(private readonly artifacts: ArtifactRepository, private readonly profiles: DatabaseConnectionResolver,
    private readonly reader = readMongo) {}

  async read(context: RequestContext, dataSource: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (dataSource.type !== 'database-documents') throw new AppError('source_type_mismatch', 400, 'JSONライクDB readerにはJSONライクDB接続が必要です。')
    const profile = await this.profiles.resolve(dataSource.connectionId, 'documents') as DocumentProfile
    const limit = requestedLimit(config.parameters, dataSource.maxDocuments)
    let rows: TableRow[]
    try { rows = await this.reader(dataSource, profile, limit) }
    catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('database_documents_read_failed', 502, 'JSONライクデータソースを読み取れませんでした。管理者へ確認してください。')
    }
    return this.artifacts.createDocuments(context, `${dataSource.id}-response`, rows, [
      `source:${dataSource.id}@${dataSource.version}`, 'trust:untrusted', 'transport:database-documents',
      `collection:${dataSource.database}.${dataSource.collection}`, `limit:${limit}`,
    ], { runId })
  }
}

export const databaseConnectorInternals = { requestedLimit, jsonValue, sqlTableRows, mongodbTransportAllowed }
