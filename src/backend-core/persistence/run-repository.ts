import type { RequestContext } from '../../shared/request-context'
import type { WorkflowRun } from '../../shared/workflow'
import type { BackendDatabase } from '../../backend-core/persistence/backend-database'
import type { SavedWorkflow } from './workflow-repository'
export class RunRepository {
  constructor(private readonly database: BackendDatabase) {}
  async start(context: RequestContext, id: string, saved: SavedWorkflow): Promise<void> {
    await this.database.query.insertInto('runs').values({ id, workspace_id: context.workspace.id, workflow_id: saved.workflow.id,
      workflow_version: saved.version, status: 'running', requested_by: context.principal.id,
      started_at: new Date().toISOString(), summary_json: '{}' }).execute()
  }
  async finish(context: RequestContext, run: WorkflowRun): Promise<void> {
    const result = await this.database.query.updateTable('runs').set({ status: run.status, finished_at: new Date().toISOString(),
      summary_json: JSON.stringify(run) }).where('id', '=', run.id).where('workspace_id', '=', context.workspace.id).executeTakeFirst()
    if (Number(result.numUpdatedRows) !== 1) throw new Error('run_not_found')
  }
  async fail(context: RequestContext, id: string, code: string): Promise<void> {
    await this.database.query.updateTable('runs').set({ status: 'failed', finished_at: new Date().toISOString(),
      summary_json: JSON.stringify({ errorCode: code }) }).where('id', '=', id).where('workspace_id', '=', context.workspace.id).execute()
  }
  async list(context: RequestContext, limit = 50): Promise<Array<{ id: string; workflowId: string; workflowVersion: number; status: string; startedAt: string; finishedAt?: string; summary: unknown }>> {
    const rows = await this.database.query.selectFrom('runs').select(['id', 'workflow_id', 'workflow_version', 'status',
      'started_at', 'finished_at', 'summary_json']).where('workspace_id', '=', context.workspace.id)
      .orderBy('started_at', 'desc').limit(limit).execute() as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, workflowId: row.workflow_id as string,
      workflowVersion: Number(row.workflow_version), status: row.status as string, startedAt: row.started_at as string,
      finishedAt: row.finished_at as string | undefined, summary: JSON.parse(row.summary_json as string) }))
  }
}
