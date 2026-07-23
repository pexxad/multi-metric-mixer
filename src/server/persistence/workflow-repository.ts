import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../errors'
import type { RequestContext } from '../request-context'
import { canEdit } from '../request-context'
import { validateWorkflow } from '../workflow-validation'
import type { Workflow } from '../../shared/workflow'
import type { ApplicationDatabase } from './database'

export type WorkflowChangeSource = 'manual' | 'agent' | 'import' | 'migration'
export type SavedWorkflow = {
  workflow: Workflow
  version: number
  contentHash: string
  status: 'draft' | 'ready' | 'stale' | 'archived'
  validation: { valid: boolean; errors: string[] }
  updatedAt: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export class WorkflowRepository {
  constructor(private readonly database: ApplicationDatabase) {}

  async save(context: RequestContext, input: unknown, source: WorkflowChangeSource, expectedVersion?: number): Promise<SavedWorkflow> {
    if (!canEdit(context)) throw new AppError('workflow_edit_denied', 403, 'WorkspaceでWorkflowを編集する権限がありません。')
    const validation = validateWorkflow(input)
    const parsed = validation.workflow
    if (!parsed) throw new AppError('workflow_schema_invalid', 400, 'Workflow定義が不正です。', validation.errors)
    const hash = contentHash(parsed)
    const now = new Date().toISOString()
    const existing = await this.database.query.selectFrom('workflows').select(['workspace_id', 'current_version', 'status'])
      .where('id', '=', parsed.id).executeTakeFirst() as { workspace_id: string; current_version: number; status: SavedWorkflow['status'] } | undefined
    if (existing && existing.workspace_id !== context.workspace.id) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
    if (existing?.status === 'archived') throw new AppError('workflow_archived', 409, '削除済みのWorkflowは更新できません。')
    if (existing && expectedVersion !== undefined && Number(existing.current_version) !== expectedVersion) {
      throw new AppError('workflow_version_conflict', 409, 'Workflowが別の操作で更新されています。再読込してください。')
    }
    if (existing) {
      const current = await this.database.query.selectFrom('workflow_versions').select('content_hash')
        .where('workflow_id', '=', parsed.id).where('version', '=', existing.current_version).executeTakeFirstOrThrow() as { content_hash: string }
      if (current.content_hash === hash) return this.require(context, parsed.id)
    }
    const version = (existing?.current_version ?? 0) + 1
    const status = validation.valid ? 'ready' : 'draft'
    await this.database.query.transaction().execute(async (db) => {
      if (existing) {
        const result = await db.updateTable('workflows').set({ name: parsed.name, description: parsed.description, status,
          current_version: version, updated_by: context.principal.id, updated_at: now, lock_version: Number(existing.current_version) + 1 })
          .where('id', '=', parsed.id).where('workspace_id', '=', context.workspace.id)
          .where('current_version', '=', existing.current_version).executeTakeFirst()
        if (Number(result.numUpdatedRows) !== 1) throw new AppError('workflow_version_conflict', 409, 'Workflowが別の操作で更新されています。')
      } else {
        await db.insertInto('workflows').values({ id: parsed.id || randomUUID(), workspace_id: context.workspace.id,
          name: parsed.name, description: parsed.description, status, current_version: version, lock_version: 1,
          created_by: context.principal.id, updated_by: context.principal.id, created_at: now, updated_at: now }).execute()
      }
      await db.insertInto('workflow_versions').values({ workflow_id: parsed.id, version, definition_json: JSON.stringify(parsed),
        content_hash: hash, validation_status: validation.valid ? 'valid' : 'invalid',
        validation_errors_json: JSON.stringify(validation.errors), change_source: source,
        created_by: context.principal.id, created_at: now }).execute()
    })
    return { workflow: parsed, version, contentHash: hash, status, validation, updatedAt: now }
  }

  async require(context: RequestContext, id: string, version?: number): Promise<SavedWorkflow> {
    let query = this.database.query.selectFrom('workflows as w').innerJoin('workflow_versions as v', 'v.workflow_id', 'w.id')
      .select(['w.status', 'w.updated_at', 'w.current_version', 'v.version', 'v.definition_json', 'v.content_hash',
        'v.validation_status', 'v.validation_errors_json']).where('w.id', '=', id).where('w.workspace_id', '=', context.workspace.id)
      .where('w.status', '<>', 'archived')
    query = version === undefined ? query.whereRef('v.version', '=', 'w.current_version') : query.where('v.version', '=', version)
    const row = await query.executeTakeFirst() as {
      status: SavedWorkflow['status']; updated_at: string; current_version: number; version: number
      definition_json: string; content_hash: string; validation_status: 'valid' | 'invalid'; validation_errors_json: string
    } | undefined
    if (!row) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
    return {
      workflow: JSON.parse(row.definition_json) as Workflow,
      version: row.version,
      contentHash: row.content_hash,
      status: row.validation_status === 'valid' ? 'ready' : 'draft',
      validation: { valid: row.validation_status === 'valid', errors: JSON.parse(row.validation_errors_json) as string[] },
      updatedAt: row.updated_at,
    }
  }

  async listVersions(context: RequestContext, id: string): Promise<SavedWorkflow[]> {
    const rows = await this.database.query.selectFrom('workflows as w').innerJoin('workflow_versions as v', 'v.workflow_id', 'w.id')
      .select(['w.updated_at', 'v.version', 'v.definition_json', 'v.content_hash', 'v.validation_status',
        'v.validation_errors_json', 'v.created_at']).where('w.id', '=', id).where('w.workspace_id', '=', context.workspace.id)
      .where('w.status', '<>', 'archived')
      .orderBy('v.version', 'desc').execute() as Array<{ updated_at: string; version: number; definition_json: string;
        content_hash: string; validation_status: 'valid' | 'invalid'; validation_errors_json: string; created_at: string }>
    if (rows.length === 0) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
    return rows.map((row) => ({ workflow: JSON.parse(row.definition_json) as Workflow, version: Number(row.version),
      contentHash: row.content_hash, status: row.validation_status === 'valid' ? 'ready' : 'draft',
      validation: { valid: row.validation_status === 'valid', errors: JSON.parse(row.validation_errors_json) as string[] },
      updatedAt: row.created_at }))
  }

  async list(context: RequestContext): Promise<Array<Pick<SavedWorkflow, 'workflow' | 'version' | 'status' | 'updatedAt'>>> {
    const rows = await this.database.query.selectFrom('workflows as w')
      .innerJoin('workflow_versions as v', (join) => join.onRef('v.workflow_id', '=', 'w.id').onRef('v.version', '=', 'w.current_version'))
      .select(['w.status', 'w.updated_at', 'w.current_version', 'v.definition_json']).where('w.workspace_id', '=', context.workspace.id)
      .where('w.status', '<>', 'archived').orderBy('w.updated_at', 'desc').execute() as
      Array<{ status: SavedWorkflow['status']; updated_at: string; current_version: number; definition_json: string }>
    return rows.map((row) => ({ workflow: JSON.parse(row.definition_json) as Workflow, version: row.current_version, status: row.status, updatedAt: row.updated_at }))
  }

  async archive(context: RequestContext, id: string, expectedVersion?: number): Promise<boolean> {
    if (!canEdit(context)) throw new AppError('workflow_edit_denied', 403, 'WorkspaceでWorkflowを編集する権限がありません。')
    const existing = await this.database.query.selectFrom('workflows').select(['current_version', 'status'])
      .where('id', '=', id).where('workspace_id', '=', context.workspace.id).executeTakeFirst() as
      { current_version: number; status: SavedWorkflow['status'] } | undefined
    if (!existing || existing.status === 'archived') return false
    if (expectedVersion !== undefined && Number(existing.current_version) !== expectedVersion) {
      throw new AppError('workflow_version_conflict', 409, 'Workflowが別の操作で更新されています。再読込してください。')
    }
    const now = new Date().toISOString()
    const result = await this.database.query.updateTable('workflows').set({ status: 'archived', updated_by: context.principal.id,
      updated_at: now, lock_version: Number(existing.current_version) + 1 })
      .where('id', '=', id).where('workspace_id', '=', context.workspace.id).where('status', '<>', 'archived')
      .where('current_version', '=', existing.current_version).executeTakeFirst()
    if (Number(result.numUpdatedRows) !== 1) throw new AppError('workflow_version_conflict', 409, 'Workflowが別の操作で更新されています。再読込してください。')
    return true
  }

  async connectionUsage(context: RequestContext, sourceId: string): Promise<Array<{ workflowId: string; workflowName: string; version: number }>> {
    const workflows = await this.list(context)
    return workflows.filter(({ workflow }) => workflow.steps.some((step) => step.kind === 'query' && step.config.source === sourceId))
      .map(({ workflow, version }) => ({ workflowId: workflow.id, workflowName: workflow.name, version }))
  }
}
