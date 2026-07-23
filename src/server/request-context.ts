import type { RequestIdentity } from './auth/session-service'

export type RequestContext = RequestIdentity & {
  requestId: string
}

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
