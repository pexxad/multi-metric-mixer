import { randomUUID } from 'node:crypto'
import type { RequestContext } from '../../shared/request-context'
import type { BackendDatabase } from '../../backend-core/persistence/backend-database'

export type McpInvocationContext = RequestContext & { accessTokenId: string }

export class McpInvocationRepository {
  constructor(private readonly database: BackendDatabase) {}
  async start(context: McpInvocationContext, toolName: string, inputHash: string): Promise<string> {
    const id = `mcpinv_${randomUUID()}`
    await this.database.query.insertInto('mcp_tool_invocations').values({ id, request_id: context.requestId,
      capability_id: context.accessTokenId,
      principal_id: context.principal.id, workspace_id: context.workspace.id, workspace_role: context.workspace.role,
      membership_version: context.workspace.membershipVersion, assurance_level: context.assuranceLevel,
      tool_name: toolName, tool_version: '1', input_hash: inputHash, status: 'running',
      result_summary_json: '{}', started_at: new Date().toISOString(), finished_at: null }).execute()
    return id
  }
  async finish(id: string, status: 'completed' | 'failed' | 'cancelled', summary: Record<string, string | number | boolean | null>): Promise<void> {
    await this.database.query.updateTable('mcp_tool_invocations').set({ status, result_summary_json: JSON.stringify(summary),
      finished_at: new Date().toISOString() }).where('id', '=', id).execute()
  }
}
