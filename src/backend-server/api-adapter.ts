import { Hono } from 'hono'
import { z } from 'zod'
import type { BackendCore } from '../backend-core/runtime'
import { AppError, toProblemDetails } from '../shared/errors'
import { dataSourceRegistrationSchema } from '../backend-core/persistence/data-source-repository'
import { catalogDefinitionSchema } from '../shared/catalog'
import { workflowSchema } from '../shared/workflow'
import { contentHash } from '../shared/canonical-hash'
import { BackendCapabilityVerifier, bearerToken } from '../shared/backend-capability'
import { validateWorkflow } from '../shared/workflow-validation'
import { DataSourceAdminService } from './data-source-admin-service'

const requestSchema = z.object({
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict()

const adminOperations = new Set([
  'dataSource.register',
  'dataSource.update',
  'dataSource.archive',
  'upload.ingestAndRegister',
])

export function createBackendApiAdapter(options: {
  expectedHost: string
  expectedOrigin: string
  verifier: BackendCapabilityVerifier
  core: BackendCore
}) {
  const app = new Hono()
  const connectionAdmin = new DataSourceAdminService(options.core.database)

  app.onError((error, c) => {
    const problem = toProblemDetails(error)
    return c.json(problem, problem.status as 400)
  })

  app.post('/internal/api', async (c) => {
    if (c.req.header('Host') !== options.expectedHost || c.req.header('Origin') !== options.expectedOrigin) {
      throw new AppError('invalid_internal_caller', 403, '内部APIの呼び出し元が一致しません。')
    }
    const raw = await c.req.text()
    const request = requestSchema.parse(JSON.parse(raw))
    const scopes = ['backend:api', ...(adminOperations.has(request.operation) ? ['connections:admin'] : [])]
    const context = options.verifier.verify(bearerToken(c.req.header('Authorization')), {
      action: `api:${request.operation}`,
      inputHash: contentHash(JSON.parse(raw)),
      scopes,
    })
    if (adminOperations.has(request.operation) && context.applicationRole !== 'admin') {
      throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
    }
    const input = request.input

    switch (request.operation) {
      case 'dataSource.list':
        return c.json({ value: await options.core.sources.list(context) })
      case 'dataSource.get':
        return c.json({ value: await options.core.sources.get(context, z.string().parse(input.id)) })
      case 'dataSource.register':
        return c.json({ value: await connectionAdmin.register(context, dataSourceRegistrationSchema.parse(input.source)) })
      case 'dataSource.update':
        return c.json({ value: await connectionAdmin.update(context, z.string().parse(input.id),
          dataSourceRegistrationSchema.parse(input.source), z.number().int().positive().parse(input.expectedVersion)) })
      case 'dataSource.archive':
        return c.json({ value: await connectionAdmin.archive(context, z.string().parse(input.id)) })
      case 'dataSource.connectionUsage':
        return c.json({ value: await options.core.workflows.connectionUsage(context, z.string().parse(input.id)) })
      case 'catalog.listEffective':
        return c.json({ value: await options.core.catalogs.listEffective(context) })
      case 'catalog.bundle':
        return c.json({ value: await options.core.catalogs.bundle(context, z.string().parse(input.sourceId)) })
      case 'catalog.savePersonal':
        return c.json({ value: await options.core.catalogs.savePersonal(context, z.string().parse(input.sourceId),
          catalogDefinitionSchema.parse(input.definition), z.number().int().nonnegative().optional().parse(input.expectedVersion)) })
      case 'catalog.resetPersonal':
        return c.json({ value: await options.core.catalogs.resetPersonal(context, z.string().parse(input.sourceId)) })
      case 'catalog.saveCanonical':
        return c.json({ value: await options.core.catalogs.saveCanonical(context, z.string().parse(input.sourceId),
          catalogDefinitionSchema.parse(input.definition), z.number().int().nonnegative().optional().parse(input.expectedVersion)) })
      case 'catalog.promotePersonal':
        return c.json({ value: await options.core.catalogs.promotePersonal(context, z.string().parse(input.sourceId),
          z.number().int().nonnegative().optional().parse(input.expectedCanonicalVersion)) })
      case 'workflow.list':
        return c.json({ value: await options.core.workflows.list(context) })
      case 'workflow.listVersions':
        return c.json({ value: await options.core.workflows.listVersions(context, z.string().parse(input.id)) })
      case 'workflow.require':
        return c.json({ value: await options.core.workflows.require(context, z.string().parse(input.id),
          z.number().int().positive().optional().parse(input.version)) })
      case 'workflow.save':
        return c.json({ value: await options.core.workflows.save(context, workflowSchema.parse(input.workflow),
          z.enum(['manual', 'agent', 'import', 'migration']).parse(input.changeSource),
          z.number().int().nonnegative().optional().parse(input.expectedVersion)) })
      case 'workflow.archive':
        return c.json({ value: await options.core.workflows.archive(context, z.string().parse(input.id),
          z.number().int().positive().optional().parse(input.expectedVersion)) })
      case 'workflow.validate':
        return c.json({ value: validateWorkflow(input.workflow) })
      case 'workflow.transfer.prepare':
        return c.json({ value: await options.core.transfers.prepare(context, z.string().parse(input.id),
          z.number().int().positive().optional().parse(input.version)) })
      case 'workflow.transfer.import':
        return c.json({ value: await options.core.transfers.import(context, input.transfer) })
      case 'run.list':
        return c.json({ value: await options.core.runs.list(context) })
      case 'artifact.list':
        return c.json({ value: await options.core.artifacts.list(context) })
      case 'artifact.get':
        return c.json({ value: serializeArtifact(await options.core.artifacts.get(context, z.string().parse(input.id))) })
      case 'upload.ingestAndRegister': {
        const format = z.enum(['json', 'csv']).parse(input.format)
        const artifact = await options.core.uploads.ingest(context, {
          format,
          filename: z.string().optional().parse(input.filename),
          contentType: z.string().parse(input.contentType),
          bytes: Buffer.from(z.string().parse(input.bytesBase64), 'base64'),
        })
        const source = await connectionAdmin.register(context, {
          id: z.string().parse(input.sourceId),
          name: z.string().parse(input.sourceName),
          type: 'upload-artifact',
          artifactId: artifact.id,
          format,
        })
        return c.json({ value: { artifact: options.core.artifacts.summary(artifact), source } })
      }
      default:
        throw new AppError('backend_operation_not_found', 404, '内部API操作が見つかりません。')
    }
  })

  return app
}

function serializeArtifact(artifact: Awaited<ReturnType<BackendCore['artifacts']['get']>>) {
  if (!artifact) return undefined
  const { content, ...metadata } = artifact
  return { ...metadata, ...(content ? { contentBase64: Buffer.from(content).toString('base64') } : {}) }
}
