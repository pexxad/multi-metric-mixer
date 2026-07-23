import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { Pool } from 'pg'

export type DatabaseDriver =
  | { kind: 'sqlite'; filename: string }
  | { kind: 'postgres'; connectionString: string; caCertificate: string; maxConnections?: number }

/**
 * The application only exposes Kysely's portable query surface to repositories.
 * Driver construction and migrations remain here so BFF and MCP use one logical
 * schema without importing one another's runtime code.
 */
export class ApplicationDatabase {
  readonly query: Kysely<Record<string, Record<string, unknown>>>
  readonly driver: DatabaseDriver['kind']

  private constructor(query: Kysely<Record<string, Record<string, unknown>>>, driver: DatabaseDriver['kind']) {
    this.query = query
    this.driver = driver
  }

  static async open(driver: DatabaseDriver): Promise<ApplicationDatabase> {
    if (driver.kind === 'sqlite') {
      if (driver.filename !== ':memory:') mkdirSync(dirname(driver.filename), { recursive: true, mode: 0o700 })
      const sqlite = new BetterSqlite3(driver.filename)
      sqlite.pragma('foreign_keys = ON')
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('busy_timeout = 5000')
      const database = new ApplicationDatabase(new Kysely({ dialect: new SqliteDialect({ database: sqlite }) }), 'sqlite')
      await database.migrate()
      return database
    }
    const pool = new Pool({ connectionString: driver.connectionString, max: driver.maxConnections ?? 10,
      ssl: { rejectUnauthorized: true, ca: driver.caCertificate } })
    const database = new ApplicationDatabase(new Kysely({ dialect: new PostgresDialect({ pool }) }), 'postgres')
    await database.migrate()
    return database
  }

  private async migrate(): Promise<void> {
    if (this.driver === 'postgres') {
      await this.query.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(734821901)`.execute(transaction)
        await this.migrateSchema(transaction)
      })
      return
    }
    await this.migrateSchema(this.query)
  }

  private async migrateSchema(database: Kysely<Record<string, Record<string, unknown>>>): Promise<void> {
    const schema = database.schema
    await schema.createTable('principals').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('display_name', 'text', (c) => c.notNull())
      .addColumn('email', 'text')
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull()).execute()
    await schema.createTable('auth_identities').ifNotExists()
      .addColumn('provider_key', 'text', (c) => c.notNull())
      .addColumn('subject', 'text', (c) => c.notNull())
      .addColumn('principal_id', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('claims_json', 'text', (c) => c.notNull())
      .addColumn('last_authenticated_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('auth_identities_pk', ['provider_key', 'subject']).execute()
    await schema.createTable('workspaces').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('slug', 'text', (c) => c.notNull().unique())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull()).execute()
    await schema.createTable('workspace_memberships').ifNotExists()
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('principal_id', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('role', 'text', (c) => c.notNull())
      .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspace_memberships_pk', ['workspace_id', 'principal_id']).execute()
    await schema.createTable('auth_sessions').ifNotExists()
      .addColumn('session_hash', 'text', (c) => c.primaryKey())
      .addColumn('principal_id', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('active_workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('assurance_level', 'text', (c) => c.notNull())
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('rotated_at', 'bigint')
      .addColumn('revoked_at', 'bigint')
      .addColumn('logout_hint_ciphertext', 'text').execute()
    await schema.createTable('auth_transactions').ifNotExists()
      .addColumn('transaction_hash', 'text', (c) => c.primaryKey())
      .addColumn('provider_key', 'text', (c) => c.notNull())
      .addColumn('encrypted_payload', 'text', (c) => c.notNull())
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull()).execute()
    await schema.createTable('data_sources').ifNotExists()
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('id', 'text', (c) => c.notNull())
      .addColumn('version', 'integer', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('access_mode', 'text', (c) => c.notNull())
      .addColumn('definition_json', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('data_sources_pk', ['workspace_id', 'id']).execute()
    await schema.createTable('data_source_versions').ifNotExists()
      .addColumn('workspace_id', 'text', (c) => c.notNull())
      .addColumn('data_source_id', 'text', (c) => c.notNull())
      .addColumn('version', 'integer', (c) => c.notNull())
      .addColumn('definition_json', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('data_source_versions_pk', ['workspace_id', 'data_source_id', 'version'])
      .addForeignKeyConstraint('data_source_versions_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('catalog_versions').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull())
      .addColumn('data_source_id', 'text', (c) => c.notNull())
      .addColumn('owner_key', 'text', (c) => c.notNull())
      .addColumn('scope', 'text', (c) => c.notNull())
      .addColumn('version', 'integer', (c) => c.notNull())
      .addColumn('base_canonical_version', 'integer')
      .addColumn('definition_json', 'text', (c) => c.notNull())
      .addColumn('schema_fingerprint', 'text', (c) => c.notNull())
      .addColumn('change_source', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('catalog_versions_owner_version_uq', ['workspace_id', 'data_source_id', 'owner_key', 'version'])
      .addForeignKeyConstraint('catalog_versions_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('catalog_heads').ifNotExists()
      .addColumn('workspace_id', 'text', (c) => c.notNull())
      .addColumn('data_source_id', 'text', (c) => c.notNull())
      .addColumn('owner_key', 'text', (c) => c.notNull())
      .addColumn('version_id', 'text', (c) => c.notNull().references('catalog_versions.id'))
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('catalog_heads_pk', ['workspace_id', 'data_source_id', 'owner_key'])
      .addForeignKeyConstraint('catalog_heads_source_fk', ['workspace_id', 'data_source_id'], 'data_sources', ['workspace_id', 'id']).execute()
    await schema.createTable('workflows').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('description', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('current_version', 'integer', (c) => c.notNull())
      .addColumn('lock_version', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('updated_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull()).execute()
    await schema.createTable('workflow_versions').ifNotExists()
      .addColumn('workflow_id', 'text', (c) => c.notNull().references('workflows.id'))
      .addColumn('version', 'integer', (c) => c.notNull())
      .addColumn('definition_json', 'text', (c) => c.notNull())
      .addColumn('content_hash', 'text', (c) => c.notNull())
      .addColumn('validation_status', 'text', (c) => c.notNull())
      .addColumn('validation_errors_json', 'text', (c) => c.notNull())
      .addColumn('change_source', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('workflow_versions_pk', ['workflow_id', 'version']).execute()
    await schema.createTable('conversations').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('workflow_id', 'text', (c) => c.references('workflows.id'))
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull()).execute()
    await schema.createTable('chat_messages').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('conversation_id', 'text', (c) => c.notNull().references('conversations.id'))
      .addColumn('sequence', 'integer', (c) => c.notNull())
      .addColumn('role', 'text', (c) => c.notNull())
      .addColumn('content_text', 'text', (c) => c.notNull())
      .addColumn('metadata_json', 'text')
      .addColumn('workflow_id', 'text')
      .addColumn('workflow_version', 'integer')
      .addColumn('client_message_id', 'text')
      .addColumn('created_by', 'text', (c) => c.references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('chat_messages_sequence_uq', ['conversation_id', 'sequence'])
      .addUniqueConstraint('chat_messages_client_uq', ['conversation_id', 'client_message_id']).execute()
    await schema.createTable('context_snapshots').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('conversation_id', 'text', (c) => c.notNull().references('conversations.id'))
      .addColumn('through_sequence', 'integer', (c) => c.notNull())
      .addColumn('workflow_id', 'text', (c) => c.notNull())
      .addColumn('workflow_version', 'integer', (c) => c.notNull())
      .addColumn('summary_json', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('context_snapshots_sequence_uq', ['conversation_id', 'through_sequence']).execute()
    await schema.createTable('runs').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('workflow_id', 'text', (c) => c.notNull())
      .addColumn('workflow_version', 'integer', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('requested_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('started_at', 'text', (c) => c.notNull())
      .addColumn('finished_at', 'text')
      .addColumn('summary_json', 'text', (c) => c.notNull()).execute()
    await schema.createTable('run_leases').ifNotExists()
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('slot', 'integer', (c) => c.notNull())
      .addColumn('request_id', 'text', (c) => c.notNull().unique())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addPrimaryKeyConstraint('run_leases_pk', ['workspace_id', 'slot']).execute()
    await schema.createTable('artifacts').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('run_id', 'text', (c) => c.references('runs.id'))
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('media_type', 'text')
      .addColumn('row_count', 'integer', (c) => c.notNull())
      .addColumn('columns_json', 'text', (c) => c.notNull())
      .addColumn('preview_json', 'text')
      .addColumn('object_key', 'text', (c) => c.notNull())
      .addColumn('content_bytes', 'integer', (c) => c.notNull())
      .addColumn('provenance_json', 'text', (c) => c.notNull())
      .addColumn('trust_level', 'text', (c) => c.notNull())
      .addColumn('classification', 'text', (c) => c.notNull())
      .addColumn('checksum', 'text', (c) => c.notNull())
      .addColumn('created_by', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'text').execute()
    await schema.createTable('mcp_execution_grants').ifNotExists()
      .addColumn('grant_hash', 'text', (c) => c.primaryKey())
      .addColumn('session_hash', 'text', (c) => c.notNull().references('auth_sessions.session_hash'))
      .addColumn('principal_id', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('membership_version', 'integer', (c) => c.notNull())
      .addColumn('tool_name', 'text', (c) => c.notNull())
      .addColumn('input_hash', 'text', (c) => c.notNull())
      .addColumn('workflow_content_hash', 'text')
      .addColumn('approval_id', 'text')
      .addColumn('request_id', 'text', (c) => c.notNull().unique())
      .addColumn('issued_at', 'bigint', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('consumed_at', 'bigint')
      .addColumn('revoked_at', 'bigint').execute()
    // createTable(...).ifNotExists() does not add columns to an existing v1 prerelease database.
    // Keep this additive migration until every supported installation has crossed the RC boundary.
    try {
      await schema.alterTable('mcp_execution_grants').addColumn('approval_id', 'text').execute()
    } catch (error) {
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : ''
      if (code !== '42701' && !/duplicate column name/i.test(message)) throw error
    }
    try {
      await schema.alterTable('auth_sessions').addColumn('logout_hint_ciphertext', 'text').execute()
    } catch (error) {
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : ''
      if (code !== '42701' && !/duplicate column name/i.test(message)) throw error
    }
    try {
      await schema.alterTable('chat_messages').addColumn('metadata_json', 'text').execute()
    } catch (error) {
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : ''
      if (code !== '42701' && !/duplicate column name/i.test(message)) throw error
    }
    await schema.createTable('audit_events').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('request_id', 'text', (c) => c.notNull())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('principal_id', 'text')
      .addColumn('workspace_id', 'text')
      .addColumn('resource_type', 'text')
      .addColumn('resource_id', 'text')
      .addColumn('outcome', 'text', (c) => c.notNull())
      .addColumn('reason_code', 'text')
      .addColumn('summary_json', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull()).execute()
    await schema.createTable('approvals').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
      .addColumn('principal_id', 'text', (c) => c.notNull().references('principals.id'))
      .addColumn('action_type', 'text', (c) => c.notNull())
      .addColumn('action_hash', 'text', (c) => c.notNull())
      .addColumn('summary_json', 'text', (c) => c.notNull())
      .addColumn('issued_at', 'bigint', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('consumed_at', 'bigint').execute()
    await schema.createTable('mcp_tool_invocations').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('request_id', 'text', (c) => c.notNull().unique())
      .addColumn('execution_grant_hash', 'text', (c) => c.notNull())
      .addColumn('session_hash', 'text', (c) => c.notNull())
      .addColumn('principal_id', 'text', (c) => c.notNull())
      .addColumn('workspace_id', 'text', (c) => c.notNull())
      .addColumn('workspace_role', 'text', (c) => c.notNull())
      .addColumn('membership_version', 'integer', (c) => c.notNull())
      .addColumn('assurance_level', 'text', (c) => c.notNull())
      .addColumn('tool_name', 'text', (c) => c.notNull())
      .addColumn('tool_version', 'text', (c) => c.notNull())
      .addColumn('input_hash', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull())
      .addColumn('result_summary_json', 'text', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .addColumn('finished_at', 'text').execute()

    for (const [name, table, columns] of [
      ['idx_workflows_workspace', 'workflows', ['workspace_id', 'updated_at']],
      ['idx_conversations_workspace', 'conversations', ['workspace_id', 'updated_at']],
      ['idx_runs_workspace', 'runs', ['workspace_id', 'started_at']],
      ['idx_artifacts_workspace', 'artifacts', ['workspace_id', 'created_at']],
      ['idx_audit_workspace', 'audit_events', ['workspace_id', 'created_at']],
      ['idx_catalog_versions_owner', 'catalog_versions', ['workspace_id', 'owner_key', 'created_at']],
    ] as const) await schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute()
  }

  async close(): Promise<void> {
    await this.query.destroy()
  }

  async health(): Promise<boolean> {
    try { await sql`select 1`.execute(this.query); return true } catch { return false }
  }

  async pruneEphemeral(now = Date.now()): Promise<void> {
    await this.query.transaction().execute(async (db) => {
      await db.deleteFrom('mcp_execution_grants').where((eb) => eb.or([
        eb('expires_at', '<=', now), eb('consumed_at', 'is not', null), eb('revoked_at', 'is not', null),
      ])).execute()
      await db.deleteFrom('approvals').where((eb) => eb.or([
        eb('expires_at', '<=', now), eb('consumed_at', 'is not', null),
      ])).execute()
      await db.deleteFrom('auth_transactions').where('expires_at', '<=', now).execute()
      await db.deleteFrom('run_leases').where('expires_at', '<=', now).execute()
      await db.deleteFrom('auth_sessions').where((eb) => eb.or([
        eb('expires_at', '<=', now), eb('revoked_at', 'is not', null),
      ])).execute()
    })
  }
}
