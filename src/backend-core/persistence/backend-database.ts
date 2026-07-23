import { Kysely, sql } from 'kysely'
import { openQuery, type DatabaseDriver } from '../../shared/persistence/database-driver'

type Query = Kysely<Record<string, Record<string, unknown>>>

export class BackendDatabase {
  private constructor(readonly query: Query, readonly driver: DatabaseDriver['kind']) {}

  static async open(driver: DatabaseDriver): Promise<BackendDatabase> {
    const database = new BackendDatabase(await openQuery(driver), driver.kind)
    await database.migrate()
    return database
  }

  private async migrate(): Promise<void> {
    if (this.driver === 'postgres') {
      await this.query.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(734821912)`.execute(transaction)
        await this.migrateSchema(transaction)
      })
    } else {
      await this.migrateSchema(this.query)
    }
  }

  private async migrateSchema(database: Query): Promise<void> {
    const schema = database.schema
    await schema.createTable('data_sources').ifNotExists()
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('id', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('type', 'text', (column) => column.notNull())
      .addColumn('access_mode', 'text', (column) => column.notNull())
      .addColumn('definition_json', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('data_sources_pk', ['workspace_id', 'id']).execute()
    await schema.createTable('data_source_versions').ifNotExists()
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('data_source_id', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('definition_json', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('data_source_versions_pk', ['workspace_id', 'data_source_id', 'version'])
      .addForeignKeyConstraint('data_source_versions_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('catalog_versions').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('data_source_id', 'text', (column) => column.notNull())
      .addColumn('owner_key', 'text', (column) => column.notNull())
      .addColumn('scope', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('base_canonical_version', 'integer')
      .addColumn('definition_json', 'text', (column) => column.notNull())
      .addColumn('schema_fingerprint', 'text', (column) => column.notNull())
      .addColumn('change_source', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addUniqueConstraint('catalog_versions_owner_version_uq', ['workspace_id', 'data_source_id', 'owner_key', 'version'])
      .addForeignKeyConstraint('catalog_versions_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('catalog_heads').ifNotExists()
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('data_source_id', 'text', (column) => column.notNull())
      .addColumn('owner_key', 'text', (column) => column.notNull())
      .addColumn('version_id', 'text', (column) => column.notNull().references('catalog_versions.id'))
      .addColumn('updated_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('catalog_heads_pk', ['workspace_id', 'data_source_id', 'owner_key'])
      .addForeignKeyConstraint('catalog_heads_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('workflows').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('description', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('current_version', 'integer', (column) => column.notNull())
      .addColumn('lock_version', 'integer', (column) => column.notNull().defaultTo(1))
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('updated_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull()).execute()
    await schema.createTable('workflow_versions').ifNotExists()
      .addColumn('workflow_id', 'text', (column) => column.notNull().references('workflows.id'))
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('definition_json', 'text', (column) => column.notNull())
      .addColumn('content_hash', 'text', (column) => column.notNull())
      .addColumn('validation_status', 'text', (column) => column.notNull())
      .addColumn('validation_errors_json', 'text', (column) => column.notNull())
      .addColumn('change_source', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('workflow_versions_pk', ['workflow_id', 'version']).execute()
    await schema.createTable('runs').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('workflow_id', 'text', (column) => column.notNull())
      .addColumn('workflow_version', 'integer', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('requested_by', 'text', (column) => column.notNull())
      .addColumn('started_at', 'text', (column) => column.notNull())
      .addColumn('finished_at', 'text')
      .addColumn('summary_json', 'text', (column) => column.notNull()).execute()
    await schema.createTable('run_leases').ifNotExists()
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('slot', 'integer', (column) => column.notNull())
      .addColumn('request_id', 'text', (column) => column.notNull().unique())
      .addColumn('expires_at', 'bigint', (column) => column.notNull())
      .addPrimaryKeyConstraint('run_leases_pk', ['workspace_id', 'slot']).execute()
    await schema.createTable('artifacts').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('run_id', 'text')
      .addColumn('type', 'text', (column) => column.notNull())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('media_type', 'text')
      .addColumn('row_count', 'integer', (column) => column.notNull())
      .addColumn('columns_json', 'text', (column) => column.notNull())
      .addColumn('preview_json', 'text')
      .addColumn('object_key', 'text', (column) => column.notNull())
      .addColumn('content_bytes', 'integer', (column) => column.notNull())
      .addColumn('provenance_json', 'text', (column) => column.notNull())
      .addColumn('trust_level', 'text', (column) => column.notNull())
      .addColumn('classification', 'text', (column) => column.notNull())
      .addColumn('checksum', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('expires_at', 'text').execute()
    await schema.createTable('mcp_tool_invocations').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('request_id', 'text', (column) => column.notNull().unique())
      .addColumn('capability_id', 'text', (column) => column.notNull())
      .addColumn('principal_id', 'text', (column) => column.notNull())
      .addColumn('workspace_id', 'text', (column) => column.notNull())
      .addColumn('workspace_role', 'text', (column) => column.notNull())
      .addColumn('membership_version', 'integer', (column) => column.notNull())
      .addColumn('assurance_level', 'text', (column) => column.notNull())
      .addColumn('tool_name', 'text', (column) => column.notNull())
      .addColumn('tool_version', 'text', (column) => column.notNull())
      .addColumn('input_hash', 'text', (column) => column.notNull())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('result_summary_json', 'text', (column) => column.notNull())
      .addColumn('started_at', 'text', (column) => column.notNull())
      .addColumn('finished_at', 'text').execute()

    for (const [name, table, columns] of [
      ['idx_workflows_workspace', 'workflows', ['workspace_id', 'updated_at']],
      ['idx_runs_workspace', 'runs', ['workspace_id', 'started_at']],
      ['idx_artifacts_workspace', 'artifacts', ['workspace_id', 'created_at']],
      ['idx_catalog_versions_owner', 'catalog_versions', ['workspace_id', 'owner_key', 'created_at']],
    ] as const) {
      await schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute()
    }
  }

  async health(): Promise<boolean> {
    try {
      await sql`select 1`.execute(this.query)
      return true
    } catch {
      return false
    }
  }

  async pruneEphemeral(now = Date.now()): Promise<void> {
    await this.query.deleteFrom('run_leases').where('expires_at', '<=', now).execute()
  }

  async close(): Promise<void> {
    await this.query.destroy()
  }
}
