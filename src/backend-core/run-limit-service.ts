import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { BackendDatabase } from '../backend-core/persistence/backend-database'

export class RunLimitService {
  constructor(private readonly database: BackendDatabase, private readonly slots: number, private readonly leaseMs = 60_000) {}
  async acquire(context: RequestContext): Promise<number> {
    return this.database.query.transaction().execute(async (db) => {
      const now = Date.now()
      await db.deleteFrom('run_leases').where('expires_at', '<=', now).execute()
      if (this.database.driver === 'postgres') await db.selectFrom('workspaces').select('id')
        .where('id', '=', context.workspace.id).forUpdate().executeTakeFirstOrThrow()
      const occupied = new Set((await db.selectFrom('run_leases').select('slot').where('workspace_id', '=', context.workspace.id).execute())
        .map((row) => Number(row.slot)))
      const slot = Array.from({ length: this.slots }, (_, index) => index + 1).find((candidate) => !occupied.has(candidate))
      if (!slot) throw new AppError('workspace_run_limit', 429, `同時実行数の上限${this.slots}件に達しています。`)
      await db.insertInto('run_leases').values({ workspace_id: context.workspace.id, slot,
        request_id: context.requestId, expires_at: now + this.leaseMs }).execute()
      return slot
    })
  }
  async release(context: RequestContext, slot: number): Promise<void> {
    await this.database.query.deleteFrom('run_leases').where('workspace_id', '=', context.workspace.id)
      .where('slot', '=', slot).where('request_id', '=', context.requestId).execute()
  }
}
