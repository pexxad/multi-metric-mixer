import type { RequestContext } from '../../shared/request-context'
import type { BackendDatabase } from '../../backend-core/persistence/backend-database'
import { dataSourceRegistrationSchema, type DataSource } from '../../shared/data-source'
export { dataSourceRegistrationSchema, type DataSource, type DataSourceRegistration } from '../../shared/data-source'

export interface DataSourceReader {
  get(context: RequestContext, id: string): Promise<DataSource | undefined>
  list(context: RequestContext): Promise<DataSource[]>
}

export class DataSourceQueryRepository implements DataSourceReader {
  constructor(private readonly database: BackendDatabase) {}

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
}
