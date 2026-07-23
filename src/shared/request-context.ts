export type AssuranceLevel = 'basic' | 'mfa' | 'strong'
export type ApplicationRole = 'admin' | 'user'
export type WorkspaceRole = 'owner' | 'editor' | 'runner' | 'viewer'
export type Principal = {
  id: string
  displayName: string
  email?: string
  status: 'active' | 'suspended' | 'deleted'
}
export type WorkspaceContext = {
  id: string
  name: string
  slug: string
  role: WorkspaceRole
  membershipVersion: number
}
export type AuthenticatedIdentity = {
  principal: Principal
  workspace: WorkspaceContext
  applicationRole: ApplicationRole
  assuranceLevel: AssuranceLevel
}
export type RequestIdentity = AuthenticatedIdentity & { sessionHash: string }
export type RequestContext = RequestIdentity & { requestId: string }

export function canEdit(context: RequestContext): boolean {
  return context.workspace.role === 'owner' || context.workspace.role === 'editor'
}

export function canRun(context: RequestContext): boolean {
  return context.workspace.role !== 'viewer'
}

export function canExport(context: RequestContext): boolean {
  return context.workspace.role === 'owner' || context.workspace.role === 'editor' || context.workspace.role === 'runner'
}

export function canManageDataSources(context: RequestContext): boolean {
  return context.applicationRole === 'admin'
}
