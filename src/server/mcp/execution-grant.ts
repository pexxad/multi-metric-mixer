import { randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../errors'
import type { RequestContext } from '../request-context'
import type { ApplicationDatabase } from '../persistence/database'
import { applicationRoleFromClaims, hashToken } from '../auth/session-service'

export type ExecutionGrantRequest = {
  action: string
  inputHash: string
  workflowContentHash?: string
  approvalId?: string
}

export class McpExecutionGrantStore {
  constructor(private readonly database: ApplicationDatabase, private readonly ttlSeconds: number) {}

  async issue(context: RequestContext, request: ExecutionGrantRequest): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const requestId = context.requestId || randomUUID()
    await this.database.query.insertInto('mcp_execution_grants').values({ grant_hash: hashToken(token),
      session_hash: context.sessionHash, principal_id: context.principal.id, workspace_id: context.workspace.id,
      membership_version: context.workspace.membershipVersion, tool_name: request.action, input_hash: request.inputHash,
      workflow_content_hash: request.workflowContentHash ?? null, approval_id: request.approvalId ?? null,
      request_id: requestId, issued_at: now,
      expires_at: now + this.ttlSeconds * 1000, consumed_at: null, revoked_at: null }).execute()
    return token
  }

  async consume(token: string | undefined, expected: ExecutionGrantRequest): Promise<RequestContext & { executionGrantHash: string }> {
    if (!token) throw new AppError('mcp_grant_required', 401, 'MCP execution grantが必要です。')
    const hash = hashToken(token)
    const now = Date.now()
    return this.database.query.transaction().execute(async (db) => {
      const row = await db.selectFrom('mcp_execution_grants as g').innerJoin('auth_sessions as s', 's.session_hash', 'g.session_hash')
        .innerJoin('principals as p', 'p.id', 'g.principal_id').innerJoin('workspaces as w', 'w.id', 'g.workspace_id')
        .innerJoin('workspace_memberships as m', (join) => join.onRef('m.workspace_id', '=', 'g.workspace_id').onRef('m.principal_id', '=', 'g.principal_id'))
        .selectAll('g').select(['s.expires_at as session_expires_at', 's.revoked_at as session_revoked_at', 's.assurance_level',
          'p.display_name', 'p.email', 'p.status as principal_status', 'w.name as workspace_name', 'w.slug',
          'w.status as workspace_status', 'm.role', 'm.version as current_membership_version'])
        .where('g.grant_hash', '=', hash).executeTakeFirst() as Record<string, unknown> | undefined
      const valid = row
        && row.consumed_at == null
        && row.revoked_at == null
        && Number(row.expires_at) > now
        && row.session_revoked_at == null
        && Number(row.session_expires_at) > now
        && row.principal_status === 'active'
        && row.workspace_status === 'active'
        && row.tool_name === expected.action
        && row.input_hash === expected.inputHash
        && Number(row.membership_version) === Number(row.current_membership_version)
        && (expected.workflowContentHash === undefined || row.workflow_content_hash === expected.workflowContentHash)
        && (expected.approvalId === undefined || row.approval_id === expected.approvalId)
      if (!valid) throw new AppError('mcp_grant_invalid', 403, 'MCP execution grantが無効、失効済み、またはrequestと一致しません。')
      const changed = await db.updateTable('mcp_execution_grants').set({ consumed_at: now }).where('grant_hash', '=', hash)
        .where('consumed_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', now).executeTakeFirst()
      if (Number(changed.numUpdatedRows) !== 1) throw new AppError('mcp_grant_replayed', 403, 'MCP execution grantはすでに使用されています。')
      const claimRows = await db.selectFrom('auth_identities').select('claims_json')
        .where('principal_id', '=', row.principal_id as string).execute() as Array<{ claims_json: string }>
      return {
        executionGrantHash: hash,
        sessionHash: row.session_hash as string,
        requestId: row.request_id as string,
        principal: {
          id: row.principal_id as string,
          displayName: row.display_name as string,
          email: row.email as string | undefined,
          status: 'active',
        },
        workspace: {
          id: row.workspace_id as string,
          name: row.workspace_name as string,
          slug: row.slug as string,
          role: row.role as RequestContext['workspace']['role'],
          membershipVersion: Number(row.current_membership_version),
        },
        applicationRole: applicationRoleFromClaims(claimRows),
        assuranceLevel: row.assurance_level as RequestContext['assuranceLevel'],
      }
    })
  }
}
