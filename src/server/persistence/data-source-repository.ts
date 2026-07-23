import { z } from 'zod'
import { AppError } from '../errors'
import type { RequestContext } from '../request-context'
import { canManageDataSources } from '../request-context'
import type { ApplicationDatabase } from './database'

const common = {
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(100),
}

const restDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('rest-json'),
  baseUrl: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'httpまたはhttpsが必要です'),
  path: z.string().min(1).startsWith('/'),
  method: z.literal('GET'),
}).strict()

const dynamoDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('dynamodb'),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  tableName: z.string().min(3).max(255).regex(/^[A-Za-z0-9_.-]+$/),
  partitionKey: z.string().min(1).max(255),
  sortKey: z.string().min(1).max(255).optional(),
  maxItems: z.number().int().min(1).max(5_000).default(1_000),
}).strict()

const cloudWatchLogsDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('cloudwatch-logs'),
  region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  logGroupName: z.string().min(1).max(512),
  maxResults: z.number().int().min(1).max(10_000).default(1_000),
  maxRangeSeconds: z.number().int().min(60).max(31 * 24 * 60 * 60).default(7 * 24 * 60 * 60),
}).strict()

const uploadArtifactDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('upload-artifact'),
  artifactId: z.string().min(1),
  format: z.enum(['json', 'csv']),
}).strict()

const databaseIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_$-]*$/)
const secretIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9/_+=.@-]+$/)
  .refine((value) => !value.includes('..'), 'secret IDに..は使用できません')

const sqlDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('sql'),
  driver: z.enum(['postgresql', 'sqlite']),
  secretId: secretIdSchema,
  schema: databaseIdentifier.optional(),
  table: databaseIdentifier,
  maxRows: z.number().int().min(1).max(5_000).default(1_000),
}).strict()

const mongoDataSourceRegistrationSchema = z.object({
  ...common,
  type: z.literal('mongodb'),
  secretId: secretIdSchema,
  database: databaseIdentifier,
  collection: databaseIdentifier,
  maxDocuments: z.number().int().min(1).max(5_000).default(1_000),
}).strict()

export const dataSourceRegistrationSchema = z.discriminatedUnion('type', [
  restDataSourceRegistrationSchema,
  dynamoDataSourceRegistrationSchema,
  cloudWatchLogsDataSourceRegistrationSchema,
  uploadArtifactDataSourceRegistrationSchema,
  sqlDataSourceRegistrationSchema,
  mongoDataSourceRegistrationSchema,
])

type DataSourceRegistration = z.infer<typeof dataSourceRegistrationSchema>
export type DataSource = DataSourceRegistration & { version: number; accessMode: 'read-only'; status: 'active' | 'archived' }

export interface DataSourceRepository {
  register(context: RequestContext, input: unknown): Promise<DataSource>
  get(context: RequestContext, id: string): Promise<DataSource | undefined>
  list(context: RequestContext): Promise<DataSource[]>
  archive(context: RequestContext, id: string): Promise<boolean>
  update(context: RequestContext, id: string, input: unknown, expectedVersion: number): Promise<DataSource>
}

export class DataSourceRepositoryAdapter implements DataSourceRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async register(context: RequestContext, input: unknown): Promise<DataSource> {
    if (!canManageDataSources(context)) throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
    const source = dataSourceRegistrationSchema.parse(input)
    const now = new Date().toISOString()
    const existing = await this.database.query.selectFrom('data_sources').select('version')
      .where('workspace_id', '=', context.workspace.id).where('id', '=', source.id).executeTakeFirst()
    if (existing) throw new AppError('connection_id_conflict', 409, `データソースID「${source.id}」は登録済みです。`)
    await this.database.query.transaction().execute(async (db) => {
      await db.insertInto('data_sources').values({ workspace_id: context.workspace.id, id: source.id,
        version: 1, name: source.name, type: source.type, access_mode: 'read-only', definition_json: JSON.stringify(source),
        status: 'active', created_by: context.principal.id, created_at: now, updated_at: now }).execute()
      await db.insertInto('data_source_versions').values({ workspace_id: context.workspace.id,
        data_source_id: source.id, version: 1, definition_json: JSON.stringify(source), created_by: context.principal.id,
        created_at: now }).execute()
    })
    return { ...source, version: 1, accessMode: 'read-only', status: 'active' }
  }

  async get(context: RequestContext, id: string): Promise<DataSource | undefined> {
    const row = await this.database.query.selectFrom('data_sources').select(['definition_json', 'version', 'status'])
      .where('workspace_id', '=', context.workspace.id).where('id', '=', id).where('status', '=', 'active')
      .executeTakeFirst() as { definition_json: string; version: number; status: 'active' } | undefined
    return row ? { ...dataSourceRegistrationSchema.parse(JSON.parse(row.definition_json)), version: row.version, accessMode: 'read-only', status: row.status } : undefined
  }

  async list(context: RequestContext): Promise<DataSource[]> {
    const rows = await this.database.query.selectFrom('data_sources').select(['definition_json', 'version', 'status'])
      .where('workspace_id', '=', context.workspace.id).where('status', '=', 'active').orderBy('created_at').orderBy('id')
      .execute() as Array<{ definition_json: string; version: number; status: 'active' }>
    return rows.map((row) => ({ ...dataSourceRegistrationSchema.parse(JSON.parse(row.definition_json)),
      version: row.version, accessMode: 'read-only' as const, status: row.status }))
  }

  async archive(context: RequestContext, id: string): Promise<boolean> {
    if (!canManageDataSources(context)) throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
    return this.database.query.transaction().execute(async (db) => {
      const current = await db.selectFrom('data_sources').select(['version', 'definition_json'])
        .where('workspace_id', '=', context.workspace.id).where('id', '=', id).where('status', '=', 'active').executeTakeFirst() as
        { version: number; definition_json: string } | undefined
      if (!current) return false
      const now = new Date().toISOString(); const version = Number(current.version) + 1
      const result = await db.updateTable('data_sources').set({ status: 'archived', version, updated_at: now })
        .where('workspace_id', '=', context.workspace.id).where('id', '=', id).where('status', '=', 'active')
        .where('version', '=', current.version).executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) return false
      await db.insertInto('data_source_versions').values({ workspace_id: context.workspace.id, data_source_id: id,
        version, definition_json: current.definition_json, created_by: context.principal.id, created_at: now }).execute()
      return true
    })
  }

  async update(context: RequestContext, id: string, input: unknown, expectedVersion: number): Promise<DataSource> {
    if (!canManageDataSources(context)) throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
    const source = dataSourceRegistrationSchema.parse(input)
    if (source.id !== id) throw new AppError('connection_id_immutable', 400, 'データソースIDは変更できません。')
    const now = new Date().toISOString()
    const version = expectedVersion + 1
    await this.database.query.transaction().execute(async (db) => {
      const result = await db.updateTable('data_sources').set({ name: source.name, type: source.type,
        definition_json: JSON.stringify(source), version, updated_at: now }).where('workspace_id', '=', context.workspace.id)
        .where('id', '=', id).where('status', '=', 'active').where('version', '=', expectedVersion).executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) throw new AppError('connection_version_conflict', 409, '接続設定が別の操作で更新されています。')
      await db.insertInto('data_source_versions').values({ workspace_id: context.workspace.id, data_source_id: id,
        version, definition_json: JSON.stringify(source), created_by: context.principal.id, created_at: now }).execute()
    })
    return { ...source, version, accessMode: 'read-only', status: 'active' }
  }
}
