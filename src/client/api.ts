import type { AgentResponse, AgentToolActivity } from '../shared/api'
import type { Workflow, WorkflowRun } from '../shared/workflow'
import type { CatalogBundle, CatalogDefinition, CatalogVersion } from '../shared/catalog'
import type { DataSource as StoredDataSource, DataSourceCapability, DataSourceRegistration } from '../shared/data-source'

export type AuthProvider = { key: string; label: string }
export type AuthSession = {
  authenticated: true
  principal: { displayName: string }
  workspace: { name: string; role: 'owner' | 'editor' | 'runner' | 'viewer' }
  applicationRole: 'admin' | 'user'
  csrfToken: string
}

export type DataSource = DataSourceCapability
export type AdminDataSource = StoredDataSource

export type ConnectionProfile = { id: string; displayName: string; dataModel: 'table' | 'documents' }

export type SavedWorkflow = {
  workflow: Workflow
  version: number
  contentHash: string
  status: 'draft' | 'ready' | 'stale' | 'archived'
  validation: { valid: boolean; errors: string[] }
  updatedAt: string
}

export type WorkflowListItem = Pick<SavedWorkflow, 'workflow' | 'version' | 'status' | 'updatedAt'>

export type Bootstrap = {
  workflowTemplate: Workflow
  workflows: WorkflowListItem[]
  dataSources: DataSource[]
  catalogs: CatalogVersion[]
  conversations: Array<{ id: string; title: string; workflowId: string | null; updatedAt: string }>
}
export type RunRecord = { id: string; workflowId: string; workflowVersion: number; status: string; startedAt: string; finishedAt?: string; summary: unknown }

type Problem = { title?: string; detail?: string; code?: string; errors?: unknown }

function problemMessage(problem: Problem, fallback: string): string {
  const summary = problem.detail ?? problem.title ?? problem.code ?? fallback
  const details = Array.isArray(problem.errors)
    ? problem.errors.filter((error): error is string => typeof error === 'string')
    : []
  return details.length > 0 ? `${summary}\n${details.map((detail) => `・${detail}`).join('\n')}` : summary
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as T | Problem | undefined
  if (!response.ok) {
    const problem = body as Problem | undefined
    throw new Error(problem ? problemMessage(problem, `HTTP ${response.status}`) : `HTTP ${response.status}`)
  }
  return body as T
}

function request<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).then((response) => parse<T>(response))
}

function mutate<T>(session: AuthSession, url: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown = {}): Promise<T> {
  return request<T>(url, { method, headers: mutationHeaders(session), body: JSON.stringify(body) })
}

export async function loadAuth(): Promise<{ session: AuthSession | null; providers: AuthProvider[] }> {
  const response = await fetch('/auth/session')
  const body = await response.json() as AuthSession | { authenticated: false; providers: AuthProvider[] }
  return response.ok ? { session: body as AuthSession, providers: [] } : { session: null, providers: (body as { providers: AuthProvider[] }).providers }
}

let pendingInitialAuth: ReturnType<typeof loadAuth> | undefined
export function loadInitialAuth(): ReturnType<typeof loadAuth> {
  pendingInitialAuth ??= loadAuth().finally(() => { pendingInitialAuth = undefined })
  return pendingInitialAuth
}

export const loadBootstrap = () => request<Bootstrap>('/api/bootstrap')
export const loadConnectionProfiles = () => request<{ connections: ConnectionProfile[] }>('/api/connection-profiles')
export const loadAdminDataSources = () => request<{ sources: AdminDataSource[] }>('/api/data-sources')

export function loadRuns() {
  return request<{ runs: RunRecord[] }>('/api/runs')
}

export function loadArtifacts() {
  return request<{ artifacts: import('../shared/workflow').ArtifactSummary[] }>('/api/artifacts')
}

export function requestArtifactDownload(session: AuthSession, artifactId: string) {
  return mutate<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(
    session, `/api/artifacts/${encodeURIComponent(artifactId)}/download-approvals`, 'POST')
}

export async function downloadArtifact(session: AuthSession, artifactId: string, approvalId: string): Promise<Blob> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ approvalId }) })
  if (!response.ok) await parse(response)
  return response.blob()
}

export const loadWorkflowVersions = (id: string) =>
  request<{ versions: SavedWorkflow[] }>(`/api/workflows/${encodeURIComponent(id)}/versions`)

function mutationHeaders(session: AuthSession): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }
}

export function saveWorkflow(session: AuthSession, workflow: Workflow, changeSource: 'manual' | 'agent' | 'import' = 'manual', expectedVersion?: number) {
  return mutate<SavedWorkflow>(session, '/api/workflows', 'POST', { workflow, changeSource, expectedVersion })
}

export function archiveWorkflow(session: AuthSession, id: string, expectedVersion: number) {
  return mutate<{ archived: true }>(session, `/api/workflows/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion })
}

export function requestWorkflowRunApproval(session: AuthSession, workflowId: string, version: number) {
  return mutate<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(
    session, `/api/workflows/${encodeURIComponent(workflowId)}/run-approvals`, 'POST', { version })
}

export function executeWorkflow(session: AuthSession, workflowId: string, version: number, approvalId?: string,
  conversationId?: string) {
  return mutate<{ run: WorkflowRun }>(
    session, `/api/workflows/${encodeURIComponent(workflowId)}/runs`, 'POST', { version, approvalId, conversationId })
}

export function respondToAgent(session: AuthSession, input: {
  message: string
  workflow: Workflow
  conversationId?: string
  clientMessageId: string
}, onActivity?: (activity: AgentToolActivity) => void): Promise<AgentResponse> {
  if (!onActivity) return mutate<AgentResponse>(session, '/api/agent/respond', 'POST', input)
  return fetch('/api/agent/respond/stream', {
    method: 'POST',
    headers: { ...mutationHeaders(session), Accept: 'text/event-stream' },
    body: JSON.stringify(input),
  }).then(async (response) => {
    if (!response.ok || !response.body) return parse<AgentResponse>(response)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: AgentResponse | undefined
    for (;;) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      buffer = buffer.replaceAll('\r\n', '\n')
      if (chunk.done && buffer.trim()) buffer += '\n\n'
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const eventName = event.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim()
        const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data) continue
        const value = JSON.parse(data) as AgentToolActivity | AgentResponse | Problem
        if (eventName === 'activity') onActivity(value as AgentToolActivity)
        else if (eventName === 'response') result = value as AgentResponse
        else if (eventName === 'error') {
          const problem = value as Problem
          throw new Error(problemMessage(problem, '分析エージェントの処理に失敗しました。'))
        }
      }
      if (chunk.done) break
    }
    if (!result) throw new Error('分析エージェントの応答が完了しませんでした。')
    return result
  })
}

export function registerSource(session: AuthSession, source: DataSourceRegistration) {
  return mutate<{ source: AdminDataSource; capability: DataSource }>(session, '/api/data-sources', 'POST', source)
}

export function archiveSource(session: AuthSession, id: string) {
  return mutate<{ archived: true }>(session, `/api/data-sources/${encodeURIComponent(id)}`, 'DELETE')
}

export function updateSource(session: AuthSession, source: AdminDataSource, expectedVersion: number) {
  const { version: _version, accessMode: _accessMode, status: _status, ...definition } = source
  return mutate<{ source: AdminDataSource; capability: DataSource }>(
    session, `/api/data-sources/${encodeURIComponent(source.id)}`, 'PATCH', { source: definition, expectedVersion })
}
export function sourceImpact(id: string) {
  return request<{ workflows: Array<{ workflowId: string; workflowName: string; version: number }> }>(
    `/api/data-sources/${encodeURIComponent(id)}/impact`)
}
export function testSource(session: AuthSession, id: string) {
  return mutate<{ artifact: import('../shared/workflow').ArtifactSummary }>(
    session, `/api/data-sources/${encodeURIComponent(id)}/test`, 'POST')
}

export function loadCatalogBundle(sourceId: string) {
  return request<CatalogBundle>(`/api/catalog/${encodeURIComponent(sourceId)}`)
}

export function loadCatalogs() {
  return request<{ catalogs: CatalogVersion[] }>('/api/catalog')
}

export function savePersonalCatalog(session: AuthSession, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) {
  return mutate<{ catalog: CatalogVersion }>(
    session, `/api/catalog/${encodeURIComponent(sourceId)}/personal`, 'POST', { definition, expectedVersion })
}

export function resetPersonalCatalog(session: AuthSession, sourceId: string) {
  return mutate<CatalogBundle>(session, `/api/catalog/${encodeURIComponent(sourceId)}/personal`, 'DELETE')
}

export function saveCanonicalCatalog(session: AuthSession, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) {
  return mutate<{ catalog: CatalogVersion }>(
    session, `/api/catalog/${encodeURIComponent(sourceId)}/canonical`, 'POST', { definition, expectedVersion })
}

export function promotePersonalCatalog(session: AuthSession, sourceId: string, expectedCanonicalVersion?: number) {
  return mutate<{ catalog: CatalogVersion }>(
    session, `/api/catalog/${encodeURIComponent(sourceId)}/promote`, 'POST', { expectedCanonicalVersion })
}

export function exploreCatalog(session: AuthSession, sourceId: string) {
  return mutate<{ catalog: CatalogVersion }>(session, `/api/catalog/${encodeURIComponent(sourceId)}/explore`, 'POST')
}
export function confirmArchiveSource(session: AuthSession, id: string) {
  return mutate<{ archived: true }>(session, `/api/data-sources/${encodeURIComponent(id)}?confirm=true`, 'DELETE')
}

export function loadConversation(id: string) {
  return request<{ id: string; title: string; messages: Array<{
    id: string; role: 'user' | 'assistant' | 'system'; content: string; metadata?: unknown; workflowId: string | null; workflowVersion: number | null
  }> }>(`/api/conversations/${encodeURIComponent(id)}`)
}

export function linkConversationWorkflow(session: AuthSession, conversationId: string, workflowId: string, workflowVersion: number) {
  return mutate<{ id: string; workflowId: string }>(
    session, `/api/conversations/${encodeURIComponent(conversationId)}/workflow-link`, 'POST', { workflowId, workflowVersion })
}

export function requestWorkflowExport(session: AuthSession, id: string, version: number) {
  return mutate<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(
    session, `/api/workflows/${encodeURIComponent(id)}/export-approvals`, 'POST', { version })
}
export function exportWorkflow(session: AuthSession, id: string, version: number, approvalId: string) {
  return mutate<Record<string, unknown>>(
    session, `/api/workflows/${encodeURIComponent(id)}/export`, 'POST', { version, approvalId })
}
export function importWorkflow(session: AuthSession, transfer: unknown) {
  return mutate<{ saved: SavedWorkflow; unresolvedConnections: Array<{ stepId: string; originalSource: string }> }>(
    session, '/api/workflows/import', 'POST', transfer)
}
export function uploadData(session: AuthSession, format: 'json' | 'csv', file: File, sourceId: string, sourceName: string) {
  const query = new URLSearchParams({ filename: file.name, sourceId, sourceName })
  return fetch(`/api/uploads/${format}?${query}`, { method: 'POST',
    headers: { 'Content-Type': format === 'json' ? 'application/json' : 'text/csv', 'X-CSRF-Token': session.csrfToken }, body: file })
    .then((response) => parse<{ artifact: import('../shared/workflow').ArtifactSummary; source: AdminDataSource; capability: DataSource }>(response))
}

export function logout(session: AuthSession) {
  return mutate<{ authenticated: false; redirectUrl: string }>(session, '/api/auth/logout', 'POST')
}
