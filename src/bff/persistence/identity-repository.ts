import { randomUUID } from 'node:crypto'
import type { BffDatabase } from '../persistence/bff-database'
import type {
  ApplicationRole,
  AssuranceLevel,
  AuthenticatedIdentity,
  Principal,
  WorkspaceContext,
  WorkspaceRole,
} from '../../shared/request-context'
export type {
  ApplicationRole,
  AssuranceLevel,
  AuthenticatedIdentity,
  Principal,
  WorkspaceContext,
  WorkspaceRole,
} from '../../shared/request-context'

export type VerifiedIdentity = { providerKey: string; subject: string; displayName: string; email?: string; groups: string[];
  applicationRole: ApplicationRole; assuranceLevel: AssuranceLevel }

const applicationWorkspace = { id: 'main', name: 'Main Workspace', slug: 'main' }

export class IdentityRepository {
  constructor(private readonly database: BffDatabase) {}

  async resolve(identity: VerifiedIdentity): Promise<AuthenticatedIdentity> {
    return this.database.query.transaction().execute(async (db) => {
      const now = new Date().toISOString()
      const existing = await db.selectFrom('auth_identities as i').innerJoin('principals as p', 'p.id', 'i.principal_id')
        .select(['p.id', 'p.display_name', 'p.email', 'p.status'])
        .where('i.provider_key', '=', identity.providerKey).where('i.subject', '=', identity.subject).executeTakeFirst() as
        { id: string; display_name: string; email?: string; status: Principal['status'] } | undefined
      let principal: Principal
      if (existing) {
        if (existing.status !== 'active') throw new Error('principal_not_active')
        await db.updateTable('principals').set({ display_name: identity.displayName, email: identity.email ?? null, updated_at: now })
          .where('id', '=', existing.id).execute()
        await db.updateTable('auth_identities').set({ claims_json: JSON.stringify({ groups: identity.groups,
          applicationRole: identity.applicationRole }), last_authenticated_at: now })
          .where('provider_key', '=', identity.providerKey).where('subject', '=', identity.subject).execute()
        principal = { id: existing.id, displayName: identity.displayName, email: identity.email, status: 'active' }
      } else {
        const principalId = randomUUID()
        await db.insertInto('principals').values({ id: principalId, display_name: identity.displayName, email: identity.email ?? null,
          status: 'active', created_at: now, updated_at: now }).execute()
        await db.insertInto('auth_identities').values({ provider_key: identity.providerKey, subject: identity.subject,
          principal_id: principalId, claims_json: JSON.stringify({ groups: identity.groups, applicationRole: identity.applicationRole }),
          last_authenticated_at: now }).execute()
        principal = { id: principalId, displayName: identity.displayName, email: identity.email, status: 'active' }
      }
      await db.insertInto('workspaces').values({ ...applicationWorkspace, status: 'active', created_at: now, updated_at: now })
        .onConflict((conflict) => conflict.column('id').doNothing()).execute()
      await db.insertInto('workspace_memberships').values({ workspace_id: applicationWorkspace.id, principal_id: principal.id,
        role: 'editor', version: 1, created_at: now, updated_at: now })
        .onConflict((conflict) => conflict.columns(['workspace_id', 'principal_id']).doNothing()).execute()
      const workspace = await db.selectFrom('workspace_memberships as m').innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
        .select(['w.id', 'w.name', 'w.slug', 'm.role', 'm.version']).where('m.principal_id', '=', principal.id)
        .where('m.workspace_id', '=', applicationWorkspace.id).where('w.status', '=', 'active').executeTakeFirst() as
        { id: string; name: string; slug: string; role: WorkspaceRole; version: number } | undefined
      if (!workspace) throw new Error('active_workspace_required')
      return { principal, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug,
        role: workspace.role, membershipVersion: Number(workspace.version) }, applicationRole: identity.applicationRole,
        assuranceLevel: identity.assuranceLevel }
    })
  }

  async requireMembership(principalId: string, workspaceId: string): Promise<WorkspaceContext> {
    const row = await this.database.query.selectFrom('workspace_memberships as m').innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
      .select(['w.id', 'w.name', 'w.slug', 'm.role', 'm.version']).where('m.principal_id', '=', principalId)
      .where('m.workspace_id', '=', workspaceId).where('w.status', '=', 'active').executeTakeFirst() as
      { id: string; name: string; slug: string; role: WorkspaceRole; version: number } | undefined
    if (!row) throw new Error('workspace_access_denied')
    return { id: row.id, name: row.name, slug: row.slug, role: row.role, membershipVersion: Number(row.version) }
  }
}
