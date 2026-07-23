import { AppError } from '../shared/errors'
import { canManageDataSources, type RequestContext } from '../shared/request-context'
import {
  dataSourceRegistrationSchema,
  type DataSource,
} from '../backend-core/persistence/data-source-repository'
import type { BackendDatabase } from '../backend-core/persistence/backend-database'

/**
 * Connection mutation is an API-adapter-only capability. The MCP adapter never
 * imports this module and cannot register these operations as tools.
 */
export class DataSourceAdminService {
  constructor(private readonly database: BackendDatabase) {}

  async register(context: RequestContext, input: unknown): Promise<DataSource> {
    this.authorize(context)
    const source = dataSourceRegistrationSchema.parse(input)
    const now = new Date().toISOString()
    const existing = await this.database.query.selectFrom('data_sources').select('version')
      .where('workspace_id', '=', context.workspace.id).where('id', '=', source.id).executeTakeFirst()
    if (existing) throw new AppError('connection_id_conflict', 409, `データソースID「${source.id}」は登録済みです。`)
    await this.database.query.transaction().execute(async (database) => {
      await database.insertInto('data_sources').values({
        workspace_id: context.workspace.id,
        id: source.id,
        version: 1,
        name: source.name,
        type: source.type,
        access_mode: 'read-only',
        definition_json: JSON.stringify(source),
        status: 'active',
        created_by: context.principal.id,
        created_at: now,
        updated_at: now,
      }).execute()
      await database.insertInto('data_source_versions').values({
        workspace_id: context.workspace.id,
        data_source_id: source.id,
        version: 1,
        definition_json: JSON.stringify(source),
        created_by: context.principal.id,
        created_at: now,
      }).execute()
    })
    return { ...source, version: 1, accessMode: 'read-only', status: 'active' }
  }

  async archive(context: RequestContext, id: string): Promise<boolean> {
    this.authorize(context)
    return this.database.query.transaction().execute(async (database) => {
      const current = await database.selectFrom('data_sources').select(['version', 'definition_json'])
        .where('workspace_id', '=', context.workspace.id).where('id', '=', id).where('status', '=', 'active').executeTakeFirst() as
        { version: number; definition_json: string } | undefined
      if (!current) return false
      const now = new Date().toISOString()
      const version = Number(current.version) + 1
      const result = await database.updateTable('data_sources').set({ status: 'archived', version, updated_at: now })
        .where('workspace_id', '=', context.workspace.id).where('id', '=', id).where('status', '=', 'active')
        .where('version', '=', current.version).executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) return false
      await database.insertInto('data_source_versions').values({
        workspace_id: context.workspace.id,
        data_source_id: id,
        version,
        definition_json: current.definition_json,
        created_by: context.principal.id,
        created_at: now,
      }).execute()
      return true
    })
  }

  async update(context: RequestContext, id: string, input: unknown, expectedVersion: number): Promise<DataSource> {
    this.authorize(context)
    const source = dataSourceRegistrationSchema.parse(input)
    if (source.id !== id) throw new AppError('connection_id_immutable', 400, 'データソースIDは変更できません。')
    const now = new Date().toISOString()
    const version = expectedVersion + 1
    await this.database.query.transaction().execute(async (database) => {
      const result = await database.updateTable('data_sources').set({
        name: source.name,
        type: source.type,
        definition_json: JSON.stringify(source),
        version,
        updated_at: now,
      }).where('workspace_id', '=', context.workspace.id).where('id', '=', id)
        .where('status', '=', 'active').where('version', '=', expectedVersion).executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) {
        throw new AppError('connection_version_conflict', 409, '接続設定が別の操作で更新されています。')
      }
      await database.insertInto('data_source_versions').values({
        workspace_id: context.workspace.id,
        data_source_id: id,
        version,
        definition_json: JSON.stringify(source),
        created_by: context.principal.id,
        created_at: now,
      }).execute()
    })
    return { ...source, version, accessMode: 'read-only', status: 'active' }
  }

  private authorize(context: RequestContext): void {
    if (!canManageDataSources(context)) {
      throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
    }
  }
}
