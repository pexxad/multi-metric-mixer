import { randomUUID } from 'node:crypto'
import { AppError } from './errors'
import type { RequestContext } from './request-context'
import type { ApplicationDatabase } from './persistence/database'
import { contentHash } from './persistence/workflow-repository'

export type ApprovalAction =
  | { type: 'workflow_export'; workflowId: string; version: number; contentHash: string }
  | { type: 'workflow_run_export'; workflowId: string; version: number; contentHash: string; outputStepIds: string[] }
  | { type: 'artifact_download'; artifactId: string; checksum: string }

export class ApprovalService {
  constructor(private readonly database: ApplicationDatabase, private readonly ttlMs = 5 * 60_000) {}

  async issue(context: RequestContext, action: ApprovalAction, summary: Record<string, unknown>): Promise<{ id: string; expiresAt: string; actionHash: string; summary: Record<string, unknown> }> {
    const id = `approval_${randomUUID()}`
    const now = Date.now()
    const actionHash = contentHash(action)
    await this.database.query.insertInto('approvals').values({ id, workspace_id: context.workspace.id,
      principal_id: context.principal.id, action_type: action.type, action_hash: actionHash,
      summary_json: JSON.stringify(summary), issued_at: now, expires_at: now + this.ttlMs, consumed_at: null }).execute()
    return { id, expiresAt: new Date(now + this.ttlMs).toISOString(), actionHash, summary }
  }

  async consume(context: RequestContext, id: string, action: ApprovalAction): Promise<void> {
    const now = Date.now()
    const result = await this.database.query.updateTable('approvals').set({ consumed_at: now }).where('id', '=', id)
      .where('workspace_id', '=', context.workspace.id).where('principal_id', '=', context.principal.id)
      .where('action_type', '=', action.type).where('action_hash', '=', contentHash(action))
      .where('consumed_at', 'is', null).where('expires_at', '>', now).executeTakeFirst()
    if (Number(result.numUpdatedRows) !== 1) throw new AppError('approval_invalid', 403, '承認が無効、期限切れ、使用済み、または対象が変更されています。')
  }
}
