import { randomUUID } from 'node:crypto'
import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { BackendCapabilityIssuer } from '../shared/backend-capability'
import { contentHash } from '../shared/canonical-hash'
import type { StoredArtifact, SavedWorkflow, WorkflowChangeSource } from '../shared/backend-contract'
import type { DataSource } from '../shared/data-source'
import type { CatalogBundle, CatalogVersion } from '../shared/catalog'
import type { CatalogDefinition } from '../shared/catalog'
import type { Workflow } from '../shared/workflow'

type ClientOptions = {
  url: URL
  origin: string
  capabilities: BackendCapabilityIssuer
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
  ): Promise<T> {
    const invocationContext = { ...context, requestId: `${context.requestId}.${randomUUID()}` }
    const body = { operation, input }
    const token = this.options.capabilities.issue(invocationContext, {
      action: `api:${operation}`,
      inputHash: contentHash(body),
      scopes,
    })
    const response = await this.fetcher(new URL('/internal/api', this.options.url), {
      method: 'POST',
      headers: {
        Host: this.options.url.host,
        Origin: this.options.origin,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
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
    list: (context: RequestContext) => this.call<DataSource[]>(context, 'dataSource.list'),
    get: (context: RequestContext, id: string) => this.call<DataSource | undefined>(context, 'dataSource.get', { id }),
    register: (context: RequestContext, source: unknown) =>
      this.call<DataSource>(context, 'dataSource.register', { source }, ['backend:api', 'connections:admin']),
    update: (context: RequestContext, id: string, source: unknown, expectedVersion: number) =>
      this.call<DataSource>(context, 'dataSource.update', { id, source, expectedVersion }, ['backend:api', 'connections:admin']),
    archive: (context: RequestContext, id: string) =>
      this.call<boolean>(context, 'dataSource.archive', { id }, ['backend:api', 'connections:admin']),
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
    validate: (context: RequestContext, workflow: unknown) =>
      this.call<{ valid: boolean; errors: string[] }>(context, 'workflow.validate', { workflow }),
  }

  readonly runs = {
    list: (context: RequestContext) => this.call<unknown[]>(context, 'run.list'),
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
