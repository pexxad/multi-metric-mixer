import { randomUUID } from 'node:crypto'
import type { RequestContext } from '../../shared/request-context'
import type { BffDatabase } from '../persistence/bff-database'

const forbiddenKey = /token|cookie|secret|password|authorization|content|prompt|body/i
function safeSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(summary).filter(([key]) => !forbiddenKey.test(key)).map(([key, value]) => {
    if (typeof value === 'string') return [key, value.replace(/[\r\n]/g, ' ').slice(0, 256)]
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value]
    return [key, '[redacted-structured-value]']
  }))
}
export class AuditRepository {
  constructor(private readonly database: BffDatabase) {}
  async record(context: RequestContext, event: { type: string; outcome: 'success' | 'denied' | 'failed'; resourceType?: string; resourceId?: string; reasonCode?: string; summary?: Record<string, unknown> }): Promise<void> {
    await this.database.query.insertInto('audit_events').values({ id: `audit_${randomUUID()}`, request_id: context.requestId,
      event_type: event.type, principal_id: context.principal.id, workspace_id: context.workspace.id,
      resource_type: event.resourceType ?? null, resource_id: event.resourceId ?? null, outcome: event.outcome,
      reason_code: event.reasonCode ?? null, summary_json: JSON.stringify(safeSummary(event.summary ?? {})),
      created_at: new Date().toISOString() }).execute()
  }
  async recordAnonymous(requestId: string, event: { type: string; outcome: 'success' | 'denied' | 'failed'; reasonCode?: string; summary?: Record<string, unknown> }): Promise<void> {
    await this.database.query.insertInto('audit_events').values({ id: `audit_${randomUUID()}`, request_id: requestId,
      event_type: event.type, principal_id: null, workspace_id: null, resource_type: null, resource_id: null,
      outcome: event.outcome, reason_code: event.reasonCode ?? null, summary_json: JSON.stringify(safeSummary(event.summary ?? {})),
      created_at: new Date().toISOString() }).execute()
  }
}
