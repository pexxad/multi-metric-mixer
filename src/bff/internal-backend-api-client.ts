import { randomUUID } from 'node:crypto'
import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { BackendAccessTokenIssuer } from '../shared/backend-access-token'
import type { StoredArtifact, SavedWorkflow, WorkflowChangeSource } from '../shared/backend-contract'
import type { DataSource, DataSourceCapability } from '../shared/data-source'
import type { PublicConnectionProfile } from '../shared/connection-profile'
import type { CatalogBundle, CatalogVersion } from '../shared/catalog'
import type { CatalogDefinition } from '../shared/catalog'
import type { Workflow } from '../shared/workflow'

type ClientOptions = {
  url: URL
  origin: string
  accessTokens: BackendAccessTokenIssuer
  fetch?: typeof fetch
}

export class InternalBackendApiClient {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch
  }

  async health(): Promise<boolean> {
    try {
      const url = new URL('/health', this.options.url)
      const response = await this.fetcher(url, {
        headers: { Host: url.host, Origin: this.options.origin },
        signal: AbortSignal.timeout(2_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async call<T>(
    context: RequestContext,
    operation: string,
    input: Record<string, unknown> = {},
    scopes: string[] = ['backend:api'],
    binding: { workflowContentHash?: string; approvalId?: string } = {},
  ): Promise<T> {
    const invocationContext = { ...context, requestId: `${context.requestId}.${randomUUID()}` }
    const body = { operation, input }
    const token = await this.options.accessTokens.issue(invocationContext, scopes)
    const response = await this.fetcher(new URL('/internal/api', this.options.url), {
      method: 'POST',
      headers: {
        Host: this.options.url.host,
        Origin: this.options.origin,
        Authorization: `Bearer ${token}`,
        'X-Request-Id': invocationContext.requestId,
        'Content-Type': 'application/json',
        ...(binding.workflowContentHash ? { 'X-Workflow-Content-Hash': binding.workflowContentHash } : {}),
        ...(binding.approvalId ? { 'X-Approval-Id': binding.approvalId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const payload = await response.json() as { value?: T; code?: string; title?: string; detail?: string }
    if (!response.ok) {
      throw new AppError(payload.code ?? 'backend_internal_request_failed', response.status,
        payload.detail ?? payload.title ?? `内部Backend APIがHTTP ${response.status}を返しました。`)
    }
    return payload.value as T
  }

  readonly sources = {
    list: (context: RequestContext) => this.call<DataSourceCapability[]>(context, 'dataSource.list'),
    listAdmin: (context: RequestContext) =>
      this.call<DataSource[]>(context, 'dataSource.listAdmin', {}, ['backend:api', 'connections:admin']),
    register: (context: RequestContext, source: unknown) =>
      this.call<DataSource>(context, 'dataSource.register', { source }, ['backend:api', 'connections:admin']),
    update: (context: RequestContext, id: string, source: unknown, expectedVersion: number) =>
      this.call<DataSource>(context, 'dataSource.update', { id, source, expectedVersion }, ['backend:api', 'connections:admin']),
    archive: (context: RequestContext, id: string) =>
      this.call<boolean>(context, 'dataSource.archive', { id }, ['backend:api', 'connections:admin']),
    test: (context: RequestContext, id: string, limit = 10) =>
      this.call<import('../shared/workflow').ArtifactSummary>(context, 'dataSource.test', { id, limit },
        ['backend:api', 'connections:admin']),
  }

  readonly connectionProfiles = {
    list: (context: RequestContext) =>
      this.call<PublicConnectionProfile[]>(context, 'connectionProfile.list', {}, ['backend:api', 'connections:admin']),
  }

  readonly catalogs = {
    listEffective: (context: RequestContext) => this.call<CatalogVersion[]>(context, 'catalog.listEffective'),
    bundle: (context: RequestContext, sourceId: string) => this.call<CatalogBundle>(context, 'catalog.bundle', { sourceId }),
    savePersonal: (context: RequestContext, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) =>
      this.call<CatalogVersion>(context, 'catalog.savePersonal', { sourceId, definition, expectedVersion }),
    resetPersonal: (context: RequestContext, sourceId: string) =>
      this.call<CatalogBundle>(context, 'catalog.resetPersonal', { sourceId }),
    saveCanonical: (context: RequestContext, sourceId: string, definition: CatalogDefinition, expectedVersion?: number) =>
      this.call<CatalogVersion>(context, 'catalog.saveCanonical', { sourceId, definition, expectedVersion }),
    promotePersonal: (context: RequestContext, sourceId: string, expectedCanonicalVersion?: number) =>
      this.call<CatalogVersion>(context, 'catalog.promotePersonal', { sourceId, expectedCanonicalVersion }),
    explorePersonal: (context: RequestContext, sourceId: string, limit = 100) =>
      this.call<{ observation: import('../shared/catalog').CatalogObservation; catalog: CatalogVersion;
        artifact: import('../shared/workflow').ArtifactSummary }>(context, 'catalog.explorePersonal', { sourceId, limit }),
  }

  readonly workflows = {
    list: (context: RequestContext) => this.call<SavedWorkflow[]>(context, 'workflow.list'),
    listVersions: (context: RequestContext, id: string) => this.call<SavedWorkflow[]>(context, 'workflow.listVersions', { id }),
    require: (context: RequestContext, id: string, version?: number) =>
      this.call<SavedWorkflow>(context, 'workflow.require', { id, version }),
    save: (context: RequestContext, workflow: Workflow, changeSource: WorkflowChangeSource, expectedVersion?: number) =>
      this.call<SavedWorkflow>(context, 'workflow.save', { workflow, changeSource, expectedVersion }),
    archive: (context: RequestContext, id: string, expectedVersion?: number) =>
      this.call<boolean>(context, 'workflow.archive', { id, expectedVersion }),
    connectionUsage: (context: RequestContext, id: string) =>
      this.call<Array<{ workflowId: string; workflowName: string; version: number }>>(context, 'dataSource.connectionUsage', { id }),
  }

  readonly runs = {
    list: (context: RequestContext) => this.call<unknown[]>(context, 'run.list'),
    execute: (context: RequestContext, id: string, version: number, workflowContentHash: string, approvalId?: string) =>
      this.call<import('../shared/workflow').WorkflowRun>(context, 'workflow.execute', { id, version }, ['backend:api'],
        { workflowContentHash, ...(approvalId ? { approvalId } : {}) }),
  }

  readonly artifacts = {
    list: (context: RequestContext) => this.call<unknown[]>(context, 'artifact.list'),
    get: async (context: RequestContext, id: string): Promise<StoredArtifact | undefined> => {
      const artifact = await this.call<(Omit<StoredArtifact, 'content'> & { contentBase64?: string }) | undefined>(
        context,
        'artifact.get',
        { id },
      )
      if (!artifact) return undefined
      const { contentBase64, ...metadata } = artifact
      return { ...metadata, ...(contentBase64 ? { content: Buffer.from(contentBase64, 'base64') } : {}) }
    },
  }

  readonly transfers = {
    prepare: (context: RequestContext, id: string, version?: number) =>
      this.call<any>(context, 'workflow.transfer.prepare', { id, version }),
    import: (context: RequestContext, transfer: unknown) =>
      this.call<any>(context, 'workflow.transfer.import', { transfer }),
  }

  uploadAndRegister(context: RequestContext, input: {
    format: 'json' | 'csv'
    filename?: string
    contentType: string
    bytes: Uint8Array
    sourceId: string
    sourceName: string
  }) {
    return this.call<any>(context, 'upload.ingestAndRegister', {
      ...input,
      bytes: undefined,
      bytesBase64: Buffer.from(input.bytes).toString('base64'),
    }, ['backend:api', 'connections:admin'])
  }
}
