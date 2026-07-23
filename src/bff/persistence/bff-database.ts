import { Kysely, sql } from 'kysely'
import { openQuery, type DatabaseDriver } from '../../shared/persistence/database-driver'

type Query = Kysely<Record<string, Record<string, unknown>>>

export class BffDatabase {
  private constructor(readonly query: Query, readonly driver: DatabaseDriver['kind']) {}

  static async open(driver: DatabaseDriver): Promise<BffDatabase> {
    const database = new BffDatabase(await openQuery(driver), driver.kind)
    await database.migrate()
    return database
  }

  private async migrate(): Promise<void> {
    if (this.driver === 'postgres') {
      await this.query.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(734821911)`.execute(transaction)
        await this.migrateSchema(transaction)
      })
    } else {
      await this.migrateSchema(this.query)
    }
  }

  private async migrateSchema(database: Query): Promise<void> {
    const schema = database.schema
    await schema.createTable('principals').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('display_name', 'text', (column) => column.notNull())
      .addColumn('email', 'text')
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull()).execute()
    await schema.createTable('auth_identities').ifNotExists()
      .addColumn('provider_key', 'text', (column) => column.notNull())
      .addColumn('subject', 'text', (column) => column.notNull())
      .addColumn('principal_id', 'text', (column) => column.notNull().references('principals.id'))
      .addColumn('claims_json', 'text', (column) => column.notNull())
      .addColumn('last_authenticated_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('auth_identities_pk', ['provider_key', 'subject']).execute()
    await schema.createTable('workspaces').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('slug', 'text', (column) => column.notNull().unique())
      .addColumn('status', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull()).execute()
    await schema.createTable('workspace_memberships').ifNotExists()
      .addColumn('workspace_id', 'text', (column) => column.notNull().references('workspaces.id'))
      .addColumn('principal_id', 'text', (column) => column.notNull().references('principals.id'))
      .addColumn('role', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull())
      .addPrimaryKeyConstraint('workspace_memberships_pk', ['workspace_id', 'principal_id']).execute()
    await schema.createTable('auth_sessions').ifNotExists()
      .addColumn('session_hash', 'text', (column) => column.primaryKey())
      .addColumn('principal_id', 'text', (column) => column.notNull().references('principals.id'))
      .addColumn('active_workspace_id', 'text', (column) => column.notNull().references('workspaces.id'))
      .addColumn('assurance_level', 'text', (column) => column.notNull())
      .addColumn('created_at', 'bigint', (column) => column.notNull())
      .addColumn('expires_at', 'bigint', (column) => column.notNull())
      .addColumn('rotated_at', 'bigint')
      .addColumn('revoked_at', 'bigint')
      .addColumn('logout_hint_ciphertext', 'text').execute()
    await schema.createTable('auth_transactions').ifNotExists()
      .addColumn('transaction_hash', 'text', (column) => column.primaryKey())
      .addColumn('provider_key', 'text', (column) => column.notNull())
      .addColumn('encrypted_payload', 'text', (column) => column.notNull())
      .addColumn('created_at', 'bigint', (column) => column.notNull())
      .addColumn('expires_at', 'bigint', (column) => column.notNull()).execute()
    await schema.createTable('conversations').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull().references('workspaces.id'))
      .addColumn('workflow_id', 'text')
      .addColumn('title', 'text', (column) => column.notNull())
      .addColumn('created_by', 'text', (column) => column.notNull().references('principals.id'))
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addColumn('updated_at', 'text', (column) => column.notNull()).execute()
    await schema.createTable('chat_messages').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('conversation_id', 'text', (column) => column.notNull().references('conversations.id'))
      .addColumn('sequence', 'integer', (column) => column.notNull())
      .addColumn('role', 'text', (column) => column.notNull())
      .addColumn('content_text', 'text', (column) => column.notNull())
      .addColumn('metadata_json', 'text')
      .addColumn('workflow_id', 'text')
      .addColumn('workflow_version', 'integer')
      .addColumn('client_message_id', 'text')
      .addColumn('created_by', 'text', (column) => column.references('principals.id'))
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addUniqueConstraint('chat_messages_sequence_uq', ['conversation_id', 'sequence'])
      .addUniqueConstraint('chat_messages_client_uq', ['conversation_id', 'client_message_id']).execute()
    await schema.createTable('context_snapshots').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('conversation_id', 'text', (column) => column.notNull().references('conversations.id'))
      .addColumn('through_sequence', 'integer', (column) => column.notNull())
      .addColumn('workflow_id', 'text', (column) => column.notNull())
      .addColumn('workflow_version', 'integer', (column) => column.notNull())
      .addColumn('summary_json', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull())
      .addUniqueConstraint('context_snapshots_sequence_uq', ['conversation_id', 'through_sequence']).execute()
    await schema.createTable('audit_events').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('request_id', 'text', (column) => column.notNull())
      .addColumn('event_type', 'text', (column) => column.notNull())
      .addColumn('principal_id', 'text')
      .addColumn('workspace_id', 'text')
      .addColumn('resource_type', 'text')
      .addColumn('resource_id', 'text')
      .addColumn('outcome', 'text', (column) => column.notNull())
      .addColumn('reason_code', 'text')
      .addColumn('summary_json', 'text', (column) => column.notNull())
      .addColumn('created_at', 'text', (column) => column.notNull()).execute()
    await schema.createTable('approvals').ifNotExists()
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('workspace_id', 'text', (column) => column.notNull().references('workspaces.id'))
      .addColumn('principal_id', 'text', (column) => column.notNull().references('principals.id'))
      .addColumn('action_type', 'text', (column) => column.notNull())
      .addColumn('action_hash', 'text', (column) => column.notNull())
      .addColumn('summary_json', 'text', (column) => column.notNull())
      .addColumn('issued_at', 'bigint', (column) => column.notNull())
      .addColumn('expires_at', 'bigint', (column) => column.notNull())
      .addColumn('consumed_at', 'bigint').execute()

    for (const [name, table, columns] of [
      ['idx_conversations_workspace', 'conversations', ['workspace_id', 'updated_at']],
      ['idx_audit_workspace', 'audit_events', ['workspace_id', 'created_at']],
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
    await this.query.transaction().execute(async (database) => {
      await database.deleteFrom('approvals').where((expression) => expression.or([
        expression('expires_at', '<=', now),
        expression('consumed_at', 'is not', null),
      ])).execute()
      await database.deleteFrom('auth_transactions').where('expires_at', '<=', now).execute()
      await database.deleteFrom('auth_sessions').where((expression) => expression.or([
        expression('expires_at', '<=', now),
        expression('revoked_at', 'is not', null),
      ])).execute()
    })
  }

  async close(): Promise<void> {
    await this.query.destroy()
  }
}
