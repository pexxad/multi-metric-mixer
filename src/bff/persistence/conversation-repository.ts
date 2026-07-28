import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { BffDatabase } from '../persistence/bff-database'

export type ConversationExchange = {
  conversationId?: string
  title: string
  clientMessageId: string
  userMessage: string
  assistantMessage: string
  assistantMetadata?: unknown
  workflowId?: string
  workflowVersion?: number
  contextSummary?: { changes: string[] }
}

export type ConversationMessage = {
  id: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: unknown
  workflowId: string | null
  workflowVersion: number | null
  createdAt: string
}

export type Conversation = {
  id: string
  title: string
  workflowId: string | null
  updatedAt: string
  messages: ConversationMessage[]
}

type ConversationSystemEvent = {
  conversationId: string
  deduplicationId: string
  content: string
  metadata: unknown
  workflowId: string
  workflowVersion: number
}

export class ConversationRepository {
  constructor(private readonly database: BffDatabase) {}

  async appendExchange(context: RequestContext, input: ConversationExchange): Promise<Conversation> {
    const id = input.conversationId ?? `conv_${randomUUID()}`
    await this.database.query.transaction().execute(async (db) => {
      const now = new Date().toISOString()
      const existing = await db.selectFrom('conversations').select('id').where('id', '=', id)
        .where('workspace_id', '=', context.workspace.id).executeTakeFirst()
      if (!existing) {
        if (input.conversationId) throw new AppError('conversation_not_found', 404, '会話が見つかりません。')
        await db.insertInto('conversations').values({ id, workspace_id: context.workspace.id, workflow_id: input.workflowId ?? null,
          title: input.title, created_by: context.principal.id, created_at: now, updated_at: now }).execute()
      }
      const seen = await db.selectFrom('chat_messages').select('id').where('conversation_id', '=', id)
        .where('client_message_id', '=', input.clientMessageId).executeTakeFirst()
      if (seen) return
      const max = await db.selectFrom('chat_messages').select(sql<number>`coalesce(max(sequence), 0)`.as('value'))
        .where('conversation_id', '=', id).executeTakeFirstOrThrow()
      const next = Number(max.value) + 1
      await db.insertInto('chat_messages').values([
        { id: `msg_${randomUUID()}`, conversation_id: id, sequence: next, role: 'user', content_text: input.userMessage,
          metadata_json: null, workflow_id: input.workflowId ?? null, workflow_version: input.workflowVersion ?? null,
          client_message_id: input.clientMessageId, created_by: context.principal.id, created_at: now },
        { id: `msg_${randomUUID()}`, conversation_id: id, sequence: next + 1, role: 'assistant', content_text: input.assistantMessage,
          metadata_json: input.assistantMetadata === undefined ? null : JSON.stringify(input.assistantMetadata),
          workflow_id: input.workflowId ?? null, workflow_version: input.workflowVersion ?? null,
          client_message_id: null, created_by: null, created_at: now },
      ]).execute()
      if (input.workflowId && input.workflowVersion && input.contextSummary) {
        await db.insertInto('context_snapshots').values({ id: `ctx_${randomUUID()}`, conversation_id: id,
          through_sequence: next + 1, workflow_id: input.workflowId, workflow_version: input.workflowVersion,
          summary_json: JSON.stringify(input.contextSummary), created_at: now }).execute()
      }
      await db.updateTable('conversations').set({ workflow_id: input.workflowId ?? undefined, updated_at: now })
        .where('id', '=', id).where('workspace_id', '=', context.workspace.id).execute()
    })
    return this.require(context, id)
  }

  async linkWorkflow(context: RequestContext, conversationId: string, workflowId: string, workflowVersion: number): Promise<Conversation> {
    await this.database.query.transaction().execute(async (db) => {
      const updated = await db.updateTable('conversations').set({ workflow_id: workflowId, updated_at: new Date().toISOString() })
        .where('id', '=', conversationId).where('workspace_id', '=', context.workspace.id).executeTakeFirst()
      if (Number(updated.numUpdatedRows) !== 1) throw new AppError('conversation_not_found', 404, '会話が見つかりません。')
      await db.updateTable('chat_messages').set({ workflow_id: workflowId, workflow_version: workflowVersion })
        .where('conversation_id', '=', conversationId).where('workflow_id', 'is', null).execute()
    })
    return this.require(context, conversationId)
  }

  async appendSystemEvent(context: RequestContext, input: ConversationSystemEvent): Promise<Conversation> {
    await this.database.query.transaction().execute(async (db) => {
      const conversation = await db.selectFrom('conversations').select('id')
        .where('id', '=', input.conversationId).where('workspace_id', '=', context.workspace.id).executeTakeFirst()
      if (!conversation) throw new AppError('conversation_not_found', 404, '会話が見つかりません。')
      const seen = await db.selectFrom('chat_messages').select('id').where('conversation_id', '=', input.conversationId)
        .where('client_message_id', '=', input.deduplicationId).executeTakeFirst()
      if (seen) return
      const max = await db.selectFrom('chat_messages').select(sql<number>`coalesce(max(sequence), 0)`.as('value'))
        .where('conversation_id', '=', input.conversationId).executeTakeFirstOrThrow()
      const now = new Date().toISOString()
      await db.insertInto('chat_messages').values({
        id: `msg_${randomUUID()}`,
        conversation_id: input.conversationId,
        sequence: Number(max.value) + 1,
        role: 'system',
        content_text: input.content,
        metadata_json: JSON.stringify(input.metadata),
        workflow_id: input.workflowId,
        workflow_version: input.workflowVersion,
        client_message_id: input.deduplicationId,
        created_by: null,
        created_at: now,
      }).execute()
      await db.updateTable('conversations').set({
        workflow_id: input.workflowId,
        updated_at: now,
      }).where('id', '=', input.conversationId).where('workspace_id', '=', context.workspace.id).execute()
    })
    return this.require(context, input.conversationId)
  }

  async list(context: RequestContext): Promise<Array<Omit<Conversation, 'messages'>>> {
    const rows = await this.database.query.selectFrom('conversations').select(['id', 'title', 'workflow_id', 'updated_at'])
      .where('workspace_id', '=', context.workspace.id).orderBy('updated_at', 'desc').limit(100).execute() as
      Array<{ id: string; title: string; workflow_id: string | null; updated_at: string }>
    return rows.map((row) => ({ id: row.id, title: row.title, workflowId: row.workflow_id, updatedAt: row.updated_at }))
  }

  async require(context: RequestContext, id: string): Promise<Conversation> {
    const row = await this.database.query.selectFrom('conversations').select(['id', 'title', 'workflow_id', 'updated_at'])
      .where('id', '=', id).where('workspace_id', '=', context.workspace.id).executeTakeFirst() as
      { id: string; title: string; workflow_id: string | null; updated_at: string } | undefined
    if (!row) throw new AppError('conversation_not_found', 404, '会話が見つかりません。')
    const messages = await this.database.query.selectFrom('chat_messages').select(['id', 'sequence', 'role', 'content_text',
      'metadata_json', 'workflow_id', 'workflow_version', 'created_at']).where('conversation_id', '=', id)
      .orderBy('sequence').execute() as Array<{ id: string; sequence: number; role: 'user' | 'assistant' | 'system'; content_text: string;
        metadata_json: string | null; workflow_id: string | null; workflow_version: number | null; created_at: string }>
    return { id: row.id, title: row.title, workflowId: row.workflow_id, updatedAt: row.updated_at,
      messages: messages.map((item) => ({ id: item.id, sequence: Number(item.sequence), role: item.role,
        content: item.content_text, metadata: item.metadata_json ? JSON.parse(item.metadata_json) : undefined,
        workflowId: item.workflow_id, workflowVersion: item.workflow_version == null ? null : Number(item.workflow_version),
        createdAt: item.created_at })) }
  }
}
