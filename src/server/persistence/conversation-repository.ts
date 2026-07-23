import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { z } from 'zod'
import { AppError } from '../errors'
import type { RequestContext } from '../request-context'
import type { ApplicationDatabase } from './database'

export const conversationExchangeSchema = z.object({
  conversationId: z.string().min(1).optional(),
  title: z.string().min(1).max(200).default('新しい会話'),
  clientMessageId: z.string().min(1).max(128),
  userMessage: z.string().min(1).max(10_000),
  assistantMessage: z.string().min(1).max(20_000),
  assistantMetadata: z.unknown().optional(),
  workflowId: z.string().min(1).optional(),
  workflowVersion: z.number().int().positive().optional(),
  contextSummary: z.object({ changes: z.array(z.string().max(500)).max(100) }).strict().optional(),
}).strict().refine((value) => Boolean(value.workflowId) === Boolean(value.workflowVersion), {
  message: 'workflowId and workflowVersion must be provided together',
})
export type ConversationExchange = z.infer<typeof conversationExchangeSchema>

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

export class ConversationRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async appendExchange(context: RequestContext, input: ConversationExchange): Promise<Conversation> {
    const id = input.conversationId ?? `conv_${randomUUID()}`
    await this.database.query.transaction().execute(async (db) => {
      const now = new Date().toISOString()
      if (input.workflowId) {
        const workflow = await db.selectFrom('workflows').select('id').where('id', '=', input.workflowId)
          .where('workspace_id', '=', context.workspace.id).executeTakeFirst()
        if (!workflow) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
      }
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
      const workflow = await db.selectFrom('workflow_versions').innerJoin('workflows', 'workflows.id', 'workflow_versions.workflow_id')
        .select('workflow_versions.workflow_id').where('workflow_versions.workflow_id', '=', workflowId)
        .where('workflow_versions.version', '=', workflowVersion).where('workflows.workspace_id', '=', context.workspace.id).executeTakeFirst()
      if (!workflow) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
      const updated = await db.updateTable('conversations').set({ workflow_id: workflowId, updated_at: new Date().toISOString() })
        .where('id', '=', conversationId).where('workspace_id', '=', context.workspace.id).executeTakeFirst()
      if (Number(updated.numUpdatedRows) !== 1) throw new AppError('conversation_not_found', 404, '会話が見つかりません。')
      await db.updateTable('chat_messages').set({ workflow_id: workflowId, workflow_version: workflowVersion })
        .where('conversation_id', '=', conversationId).where('workflow_id', 'is', null).execute()
    })
    return this.require(context, conversationId)
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
