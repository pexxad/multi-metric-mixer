import type { AgentProviderStatus, AgentResponse } from '../shared/api'
import type { Workflow, WorkflowRun } from '../shared/workflow'
import type { CatalogBundle, CatalogDefinition, CatalogVersion } from '../shared/catalog'

export type AuthProvider = { key: string; label: string }
export type AuthSession = {
  authenticated: true
  principal: { id: string; displayName: string; email?: string; status: 'active' }
  workspace: { id: string; name: string; slug: string; role: 'owner' | 'editor' | 'runner' | 'viewer'; membershipVersion: number }
  applicationRole: 'admin' | 'user'
  assuranceLevel: 'basic' | 'mfa' | 'strong'
  csrfToken: string
}

type DataSourceBase = { id: string; name: string; version: number; accessMode: 'read-only'; status: 'active' }
type RestDataSource = DataSourceBase & {
  id: string
  name: string
  type: 'rest-json'
  baseUrl: string
  path: string
  method: 'GET'
}
type DynamoDataSource = DataSourceBase & { type: 'dynamodb'; region: string; tableName: string; partitionKey: string; sortKey?: string; maxItems: number }
type CloudWatchLogsDataSource = DataSourceBase & { type: 'cloudwatch-logs'; region: string; logGroupName: string; maxResults: number; maxRangeSeconds: number }
type UploadArtifactDataSource = DataSourceBase & { type: 'upload-artifact'; artifactId: string; format: 'json' | 'csv' }
type SqlDataSource = DataSourceBase & { type: 'sql'; driver: 'postgresql' | 'sqlite'; secretId: string; schema?: string; table: string; maxRows: number }
type MongoDataSource = DataSourceBase & { type: 'mongodb'; secretId: string; database: string; collection: string; maxDocuments: number }
export type DataSource = RestDataSource | DynamoDataSource | CloudWatchLogsDataSource | UploadArtifactDataSource | SqlDataSource | MongoDataSource
type DataSourceRegistration =
  | Omit<RestDataSource, 'version' | 'accessMode' | 'status'>
  | Omit<DynamoDataSource, 'version' | 'accessMode' | 'status'>
  | Omit<CloudWatchLogsDataSource, 'version' | 'accessMode' | 'status'>
  | Omit<UploadArtifactDataSource, 'version' | 'accessMode' | 'status'>
  | Omit<SqlDataSource, 'version' | 'accessMode' | 'status'>
  | Omit<MongoDataSource, 'version' | 'accessMode' | 'status'>

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
  principal: AuthSession['principal']
  workspace: AuthSession['workspace']
  applicationRole: AuthSession['applicationRole']
  mcp: { transport: string; tools: number; dataSourceAccess: 'read-only' }
  agent: AgentProviderStatus
}
export type RunRecord = { id: string; workflowId: string; workflowVersion: number; status: string; startedAt: string; finishedAt?: string; summary: unknown }

type Problem = { title?: string; detail?: string; code?: string; errors?: unknown }

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as T | Problem | undefined
  if (!response.ok) {
    const problem = body as Problem | undefined
    throw new Error(problem?.detail ?? problem?.title ?? problem?.code ?? `HTTP ${response.status}`)
  }
  return body as T
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

export const loadBootstrap = () => fetch('/api/bootstrap').then((response) => parse<Bootstrap>(response))

export function loadRuns(_session: AuthSession) {
  return fetch('/api/runs').then((response) => parse<{ runs: RunRecord[] }>(response))
}

export function loadArtifacts(_session: AuthSession) {
  return fetch('/api/artifacts').then((response) => parse<{ artifacts: import('../shared/workflow').ArtifactSummary[] }>(response))
}

export function requestArtifactDownload(session: AuthSession, artifactId: string) {
  return fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/download-approvals`, { method: 'POST', headers: mutationHeaders(session), body: '{}' })
    .then((response) => parse<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(response))
}

export async function downloadArtifact(session: AuthSession, artifactId: string, approvalId: string): Promise<Blob> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ approvalId }) })
  if (!response.ok) await parse(response)
  return response.blob()
}

export const loadWorkflowVersions = (id: string) => fetch(`/api/workflows/${encodeURIComponent(id)}/versions`)
  .then((response) => parse<{ versions: SavedWorkflow[] }>(response))

function mutationHeaders(session: AuthSession): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }
}

export function saveWorkflow(session: AuthSession, workflow: Workflow, changeSource: 'manual' | 'agent' | 'import' = 'manual', expectedVersion?: number) {
  return fetch('/api/workflows', { method: 'POST', headers: mutationHeaders(session), body: JSON.stringify({ workflow, changeSource, expectedVersion }) })
    .then((response) => parse<SavedWorkflow>(response))
}

export function archiveWorkflow(session: AuthSession, id: string, expectedVersion: number) {
  return fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders(session),
    body: JSON.stringify({ expectedVersion }) }).then((response) => parse<{ archived: true }>(response))
}

export function requestWorkflowRunApproval(session: AuthSession, workflowId: string, version: number) {
  return fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run-approvals`, {
    method: 'POST', headers: mutationHeaders(session), body: JSON.stringify({ version }),
  }).then((response) => parse<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(response))
}

export function executeWorkflow(session: AuthSession, workflowId: string, version: number, approvalId?: string) {
  return fetch(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
    method: 'POST', headers: mutationHeaders(session), body: JSON.stringify({ version, approvalId }),
  }).then((response) => parse<{ run: WorkflowRun }>(response))
}

export function respondToAgent(session: AuthSession, input: {
  message: string
  workflow: Workflow
  conversationId?: string
  clientMessageId: string
}) {
  return fetch('/api/agent/respond', {
    method: 'POST', headers: mutationHeaders(session), body: JSON.stringify(input),
  }).then((response) => parse<AgentResponse>(response))
}

export function registerSource(session: AuthSession, source: DataSourceRegistration) {
  return fetch('/api/data-sources', { method: 'POST', headers: mutationHeaders(session), body: JSON.stringify(source) })
    .then((response) => parse<{ source: DataSource }>(response))
}

export function archiveSource(session: AuthSession, id: string) {
  return fetch(`/api/data-sources/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders(session) })
    .then((response) => parse<{ archived: true }>(response))
}

export function updateSource(session: AuthSession, source: DataSource, expectedVersion: number) {
  const { version: _version, accessMode: _accessMode, status: _status, ...definition } = source
  return fetch(`/api/data-sources/${encodeURIComponent(source.id)}`, { method: 'PATCH', headers: mutationHeaders(session),
    body: JSON.stringify({ source: definition, expectedVersion }) }).then((response) => parse<{ source: DataSource }>(response))
}
export function sourceImpact(session: AuthSession, id: string) {
  void session
  return fetch(`/api/data-sources/${encodeURIComponent(id)}/impact`)
    .then((response) => parse<{ workflows: Array<{ workflowId: string; workflowName: string; version: number }> }>(response))
}
export function testSource(session: AuthSession, id: string, parameters: Record<string, string> = {}) {
  return fetch(`/api/data-sources/${encodeURIComponent(id)}/test`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ parameters }) }).then((response) => parse<{ artifact: import('../shared/workflow').ArtifactSummary }>(response))
}

export function loadCatalogBundle(_session: AuthSession, sourceId: string) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}`).then((response) => parse<CatalogBundle>(response))
}

export function loadCatalogs(_session: AuthSession) {
  return fetch('/api/catalog').then((response) => parse<{ catalogs: CatalogVersion[] }>(response))
}

export function savePersonalCatalog(session: AuthSession, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}/personal`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ definition, expectedVersion }) }).then((response) => parse<{ catalog: CatalogVersion }>(response))
}

export function resetPersonalCatalog(session: AuthSession, sourceId: string) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}/personal`, { method: 'DELETE', headers: mutationHeaders(session) })
    .then((response) => parse<CatalogBundle>(response))
}

export function saveCanonicalCatalog(session: AuthSession, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}/canonical`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ definition, expectedVersion }) }).then((response) => parse<{ catalog: CatalogVersion }>(response))
}

export function promotePersonalCatalog(session: AuthSession, sourceId: string, expectedCanonicalVersion?: number) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}/promote`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ expectedCanonicalVersion }) }).then((response) => parse<{ catalog: CatalogVersion }>(response))
}

export function exploreCatalog(session: AuthSession, sourceId: string) {
  return fetch(`/api/catalog/${encodeURIComponent(sourceId)}/explore`, { method: 'POST', headers: mutationHeaders(session), body: '{}' })
    .then((response) => parse<{ catalog: CatalogVersion }>(response))
}
export function confirmArchiveSource(session: AuthSession, id: string) {
  return fetch(`/api/data-sources/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE', headers: mutationHeaders(session) })
    .then((response) => parse<{ archived: true }>(response))
}

export function loadConversation(id: string) {
  return fetch(`/api/conversations/${encodeURIComponent(id)}`).then((response) => parse<{ id: string; title: string; messages: Array<{
    id: string; role: 'user' | 'assistant' | 'system'; content: string; metadata?: unknown; workflowId: string | null; workflowVersion: number | null }> }>(response))
}

export function linkConversationWorkflow(session: AuthSession, conversationId: string, workflowId: string, workflowVersion: number) {
  return fetch(`/api/conversations/${encodeURIComponent(conversationId)}/workflow-link`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ workflowId, workflowVersion }) }).then((response) => parse<{ id: string; workflowId: string }>(response))
}

export function requestWorkflowExport(session: AuthSession, id: string, version: number) {
  return fetch(`/api/workflows/${encodeURIComponent(id)}/export-approvals`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ version }) }).then((response) => parse<{ id: string; expiresAt: string; summary: Record<string, unknown> }>(response))
}
export function exportWorkflow(session: AuthSession, id: string, version: number, approvalId: string) {
  return fetch(`/api/workflows/${encodeURIComponent(id)}/export`, { method: 'POST', headers: mutationHeaders(session),
    body: JSON.stringify({ version, approvalId }) }).then((response) => parse<Record<string, unknown>>(response))
}
export function importWorkflow(session: AuthSession, transfer: unknown) {
  return fetch('/api/workflows/import', { method: 'POST', headers: mutationHeaders(session), body: JSON.stringify(transfer) })
    .then((response) => parse<{ saved: SavedWorkflow; unresolvedConnections: Array<{ stepId: string; originalSource: string }> }>(response))
}
export function uploadData(session: AuthSession, format: 'json' | 'csv', file: File, sourceId: string, sourceName: string) {
  const query = new URLSearchParams({ filename: file.name, sourceId, sourceName })
  return fetch(`/api/uploads/${format}?${query}`, { method: 'POST',
    headers: { 'Content-Type': format === 'json' ? 'application/json' : 'text/csv', 'X-CSRF-Token': session.csrfToken }, body: file })
    .then((response) => parse<{ artifact: import('../shared/workflow').ArtifactSummary; source: DataSource }>(response))
}

export function logout(session: AuthSession) {
  return fetch('/api/auth/logout', { method: 'POST', headers: mutationHeaders(session) })
    .then((response) => parse<{ authenticated: false; redirectUrl: string }>(response))
}

export function appendConversationExchange(session: AuthSession, exchange: {
  conversationId?: string
  title: string
  clientMessageId: string
  userMessage: string
  assistantMessage: string
  workflowId: string
  workflowVersion: number
  contextSummary: { changes: string[] }
}) {
  return fetch('/api/conversations/exchanges', { method: 'POST', headers: mutationHeaders(session), body: JSON.stringify(exchange) })
    .then((response) => parse<{ id: string }>(response))
}
