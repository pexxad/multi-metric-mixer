import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { streamSSE } from 'hono/streaming'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import type { RuntimeConfig } from './config'
import { AppError, toProblemDetails } from '../shared/errors'
import type { ProblemDetails } from '../shared/errors'
import type { BffServices } from './runtime'
import type { RequestIdentity } from './auth/session-service'
import { dataSourceCapability, dataSourceRegistrationSchema } from '../shared/data-source'
import { canExport, canManageDataSources, canRun, type RequestContext } from '../shared/request-context'
import { sampleWorkflow, workflowSchema } from '../shared/workflow'
import { catalogDefinitionSchema } from '../shared/catalog'
import { orchestrateAgentRequest } from './agent/agent-orchestrator'

type Variables = { identity: RequestIdentity; sessionToken: string; requestId: string }
type AppEnv = { Variables: Variables }
export type AppDependencies = { config: RuntimeConfig; services: BffServices }
const agentRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1).max(128),
  message: z.string().min(1).max(10_000),
  workflow: workflowSchema,
}).strict()

function logRequestFailure(config: RuntimeConfig, error: unknown, problem: ProblemDetails): void {
  if (problem.status < 500) return
  console.error(JSON.stringify({
    level: 'error',
    event: 'request_failed',
    requestId: problem.requestId,
    code: problem.code,
    ...(config.release.endsWith('-local') && error instanceof Error ? {
      errorName: error.name,
      errorMessage: error.message,
      ...(error instanceof AppError && error.details ? { errorDetails: error.details } : {}),
    } : {}),
  }))
}

function secureCookie(config: RuntimeConfig): boolean {
  return new URL(config.publicServer.origin).protocol === 'https:'
}

function sessionCookieName(config: RuntimeConfig): string {
  return secureCookie(config) ? '__Host-session' : 'mmm_session'
}

function transactionCookieName(config: RuntimeConfig): string {
  return secureCookie(config) ? '__Host-auth-txn' : 'mmm_auth_txn'
}

function cookieOptions(config: RuntimeConfig, maxAge: number) {
  return { httpOnly: true, secure: secureCookie(config), sameSite: 'Lax' as const, path: '/', maxAge }
}

function requestContext(c: Context<AppEnv>): RequestContext {
  return { ...c.get('identity'), requestId: c.get('requestId') }
}

function dataSourceAdminContext(c: Context<AppEnv>): RequestContext {
  const context = requestContext(c)
  if (!canManageDataSources(context)) {
    throw new AppError('data_source_admin_required', 403, 'データソース設定は管理者だけが変更できます。')
  }
  return context
}

function browserConversation<T extends { messages: Array<{ metadata?: unknown }> }>(conversation: T): T {
  return { ...conversation, messages: conversation.messages.map((message) => {
    if (!message.metadata || typeof message.metadata !== 'object' || Array.isArray(message.metadata)) return message
    const { provider: _provider, ...metadata } = message.metadata as Record<string, unknown>
    return { ...message, metadata }
  }) }
}

function authenticate({ config, services }: AppDependencies): MiddlewareHandler<AppEnv> {
  const allowedOrigins = new Set(config.publicServer.allowedOrigins)
  return async (c, next) => {
    const token = getCookie(c, sessionCookieName(config))
    const identity = await services.sessions.get(token)
    if (!identity || !token) throw new AppError('authentication_required', 401, 'ログインが必要です。')
    c.set('identity', identity)
    c.set('sessionToken', token)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('Origin')
      if (!origin || !allowedOrigins.has(origin)) throw new AppError('invalid_origin', 403, 'Originが許可されていません。')
      if (!services.sessions.verifyCsrf(token, c.req.header('X-CSRF-Token'))) {
        throw new AppError('invalid_csrf_token', 403, 'CSRF tokenが無効です。')
      }
    }
    await next()
  }
}

export function createPublicApp(dependencies: AppDependencies) {
  const { config, services } = dependencies
  const app = new Hono<AppEnv>()
  app.use('*', requestId())
  app.use('*', secureHeaders({
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    crossOriginResourcePolicy: 'same-origin',
  }))
  app.use('/api/*', cors({
    origin: config.publicServer.allowedOrigins,
    credentials: true,
    allowHeaders: ['Content-Type', 'X-CSRF-Token'],
    exposeHeaders: ['X-Request-Id'],
  }))
  const standardBodyLimit = bodyLimit({
    maxSize: config.limits.apiBodyBytes,
    onError: (c) => c.json({ type: 'about:blank', title: 'Request body too large', status: 413, code: 'request_body_too_large' }, 413),
  })
  app.use('/api/*', (c, next) => c.req.path.startsWith('/api/uploads/') ? next() : standardBodyLimit(c, next))
  app.use('/api/uploads/*', bodyLimit({
    maxSize: config.limits.uploadBytes,
    onError: (c) => c.json({ type: 'about:blank', title: 'Upload too large', status: 413, code: 'upload_too_large' }, 413),
  }))
  app.onError(async (error, c) => {
    const problem = toProblemDetails(error, c.get('requestId'))
    logRequestFailure(config, error, problem)
    const identity = c.get('identity') as RequestIdentity | undefined
    const isAuthentication = c.req.path.startsWith('/auth/')
    const isDenied = problem.status === 401 || problem.status === 403
    if (isAuthentication || isDenied) {
      const event = { type: isAuthentication ? 'authentication.failed' : 'authorization.denied',
        outcome: (isDenied ? 'denied' : 'failed') as 'denied' | 'failed', reasonCode: problem.code,
        summary: { method: c.req.method, path: c.req.path } }
      await (identity ? services.audit.record({ ...identity, requestId: c.get('requestId') }, event)
        : services.audit.recordAnonymous(c.get('requestId'), event)).catch(() => undefined)
    }
    return Response.json(problem, { status: problem.status, headers: { 'Content-Type': 'application/problem+json' } })
  })

  app.get('/health', (c) => c.json({ status: 'ok', service: 'multi-metric-mixer', release: config.release }))
  app.get('/ready', async (c) => {
    const [bffStorage, backend] = await Promise.all([services.database.health(), services.backend.health()])
    return bffStorage && backend ? c.json({ status: 'ready', bffStorage: config.bffStorage.driver, backend: 'reachable' })
      : c.json({ status: 'not-ready', bffStorage, backend }, 503)
  })
  app.get('/auth/providers', (c) => c.json({ providers: services.providers.publicMetadata() }))
  app.get('/auth/session', async (c) => {
    const token = getCookie(c, sessionCookieName(config))
    const rotated = token ? await services.sessions.rotate(token) : undefined
    if (!rotated) return c.json({ authenticated: false, providers: services.providers.publicMetadata() }, 401)
    setCookie(c, sessionCookieName(config), rotated.token, cookieOptions(config, config.auth.sessionTtlSeconds))
    return c.json({
      authenticated: true,
      principal: { displayName: rotated.identity.principal.displayName },
      workspace: { name: rotated.identity.workspace.name, role: rotated.identity.workspace.role },
      applicationRole: rotated.identity.applicationRole,
      csrfToken: rotated.csrfToken,
    })
  })
  app.get('/auth/login/:providerKey', async (c) => {
    const started = await services.auth.begin(c.req.param('providerKey'), c.req.query('returnTo'))
    await services.audit.recordAnonymous(c.get('requestId'), { type: 'authentication.started', outcome: 'success',
      summary: { providerKey: c.req.param('providerKey') } })
    setCookie(c, transactionCookieName(config), started.transactionToken, cookieOptions(config, 10 * 60))
    return c.redirect(started.authorizationUrl.toString())
  })
  app.get('/auth/callback', async (c) => {
    const callbackUrl = new URL('/auth/callback', config.publicServer.origin)
    callbackUrl.search = new URL(c.req.url).search
    const finished = await services.auth.finish(getCookie(c, transactionCookieName(config)), callbackUrl)
    deleteCookie(c, transactionCookieName(config), { path: '/', secure: secureCookie(config) })
    setCookie(c, sessionCookieName(config), finished.token, cookieOptions(config, config.auth.sessionTtlSeconds))
    await services.audit.record({ ...finished.identity, requestId: c.get('requestId') }, { type: 'authentication.succeeded', outcome: 'success',
      summary: { assuranceLevel: finished.identity.assuranceLevel } })
    return c.redirect(finished.returnTo)
  })

  app.use('/api/*', authenticate(dependencies))
  app.use('/artifacts/*', authenticate(dependencies))

  app.post('/api/auth/logout', async (c) => {
    const context = requestContext(c)
    const redirectUrl = await services.auth.endSession(config.auth.providerKey, new URL('/', config.publicServer.origin).toString(),
      await services.sessions.logoutHint(c.get('sessionToken')))
    await services.sessions.revoke(c.get('sessionToken'))
    await services.audit.record(context, { type: 'authentication.logout', outcome: 'success' })
    deleteCookie(c, sessionCookieName(config), { path: '/', secure: secureCookie(config) })
    return c.json({ authenticated: false, redirectUrl: redirectUrl.toString() })
  })
  app.get('/api/bootstrap', async (c) => {
    const context = requestContext(c)
    const [workflows, conversations, dataSources, catalogs] = await Promise.all([
      services.workflows.list(context), services.conversations.list(context), services.sources.list(context), services.catalogs.listEffective(context),
    ])
    return c.json({
      workflowTemplate: sampleWorkflow,
      workflows, conversations,
      dataSources,
      catalogs,
    })
  })
  app.get('/api/data-sources', async (c) => {
    const context = requestContext(c)
    return c.json({ sources: context.applicationRole === 'admin'
      ? await services.sources.listAdmin(context)
      : await services.sources.list(context) })
  })
  app.get('/api/connection-profiles', async (c) =>
    c.json({ connections: await services.connectionProfiles.list(dataSourceAdminContext(c)) }))
  app.post('/api/data-sources', async (c) => {
    const context = dataSourceAdminContext(c)
    const body = dataSourceRegistrationSchema.parse(await c.req.json<unknown>())
    const source = await services.sources.register(context, body)
    await services.audit.record(context, { type: 'connection.created', outcome: 'success', resourceType: 'data-source',
      resourceId: source.id, summary: { type: source.type, version: source.version } })
    return c.json({ source, capability: dataSourceCapability(source) }, 201)
  })
  app.patch('/api/data-sources/:id', async (c) => {
    const context = dataSourceAdminContext(c)
    const body = z.object({ source: dataSourceRegistrationSchema, expectedVersion: z.number().int().positive() }).strict()
      .parse(await c.req.json<unknown>())
    const source = await services.sources.update(context, c.req.param('id'), body.source, body.expectedVersion)
    await services.audit.record(context, { type: 'connection.updated', outcome: 'success', resourceType: 'data-source',
      resourceId: source.id, summary: { type: source.type, version: source.version } })
    return c.json({ source, capability: dataSourceCapability(source) })
  })
  app.get('/api/data-sources/:id/impact', async (c) => c.json({
    workflows: await services.workflows.connectionUsage(dataSourceAdminContext(c), c.req.param('id')),
  }))
  app.post('/api/data-sources/:id/test', async (c) => {
    const context = dataSourceAdminContext(c)
    const sourceId = c.req.param('id')
    const artifact = await services.sources.test(context, sourceId)
    await services.audit.record(context, { type: 'connection.tested', outcome: 'success', resourceType: 'data-source',
      resourceId: sourceId, summary: { rows: artifact.rowCount } })
    return c.json({ artifact })
  })
  app.delete('/api/data-sources/:id', async (c) => {
    const context = dataSourceAdminContext(c)
    const usage = await services.workflows.connectionUsage(context, c.req.param('id'))
    if (usage.length > 0 && c.req.query('confirm') !== 'true') {
      throw new AppError('connection_in_use', 409, 'この接続を利用しているWorkflowがあります。影響を確認してから削除してください。', usage)
    }
    const archived = await services.sources.archive(context, c.req.param('id'))
    if (!archived) throw new AppError('source_not_found', 404, 'データソースが見つかりません。')
    await services.audit.record(context, { type: 'connection.archived', outcome: 'success', resourceType: 'data-source',
      resourceId: c.req.param('id'), summary: { affectedWorkflows: usage.length } })
    return c.json({ archived: true })
  })

  app.get('/api/catalog', async (c) => c.json({ catalogs: await services.catalogs.listEffective(requestContext(c)) }))
  app.get('/api/catalog/:sourceId', async (c) => c.json(await services.catalogs.bundle(requestContext(c), c.req.param('sourceId'))))
  app.post('/api/catalog/:sourceId/personal', async (c) => {
    const context = requestContext(c)
    const body = z.object({ definition: catalogDefinitionSchema, expectedVersion: z.number().int().nonnegative().optional() }).strict()
      .parse(await c.req.json<unknown>())
    const catalog = await services.catalogs.savePersonal(context, c.req.param('sourceId'), body.definition, body.expectedVersion)
    await services.audit.record(context, { type: 'catalog.personal.saved', outcome: 'success', resourceType: 'data-source',
      resourceId: c.req.param('sourceId'), summary: { version: catalog.version } })
    return c.json({ catalog }, 201)
  })
  app.delete('/api/catalog/:sourceId/personal', async (c) => {
    const context = requestContext(c)
    const bundle = await services.catalogs.resetPersonal(context, c.req.param('sourceId'))
    await services.audit.record(context, { type: 'catalog.personal.reset', outcome: 'success', resourceType: 'data-source',
      resourceId: c.req.param('sourceId'), summary: { canonicalVersion: bundle.canonical?.version } })
    return c.json(bundle)
  })
  app.post('/api/catalog/:sourceId/canonical', async (c) => {
    const context = dataSourceAdminContext(c)
    const body = z.object({ definition: catalogDefinitionSchema, expectedVersion: z.number().int().nonnegative().optional() }).strict()
      .parse(await c.req.json<unknown>())
    const catalog = await services.catalogs.saveCanonical(context, c.req.param('sourceId'), body.definition, body.expectedVersion)
    await services.audit.record(context, { type: 'catalog.canonical.saved', outcome: 'success', resourceType: 'data-source',
      resourceId: c.req.param('sourceId'), summary: { version: catalog.version } })
    return c.json({ catalog }, 201)
  })
  app.post('/api/catalog/:sourceId/promote', async (c) => {
    const context = dataSourceAdminContext(c)
    const body = z.object({ expectedCanonicalVersion: z.number().int().nonnegative().optional() }).strict()
      .parse(await c.req.json<unknown>())
    const catalog = await services.catalogs.promotePersonal(context, c.req.param('sourceId'), body.expectedCanonicalVersion)
    await services.audit.record(context, { type: 'catalog.personal.promoted', outcome: 'success', resourceType: 'data-source',
      resourceId: c.req.param('sourceId'), summary: { version: catalog.version } })
    return c.json({ catalog }, 201)
  })
  app.post('/api/catalog/:sourceId/explore', async (c) => {
    const context = requestContext(c)
    const sourceId = c.req.param('sourceId')
    const profiled = await services.catalogs.explorePersonal(context, sourceId)
    const catalog = profiled.catalog
    await services.audit.record(context, { type: 'catalog.explored', outcome: 'success', resourceType: 'data-source',
      resourceId: sourceId, summary: { personalVersion: catalog.version, fields: catalog.definition.fields.length } })
    return c.json({ catalog }, 201)
  })

  app.get('/api/workflows', async (c) => c.json({ workflows: await services.workflows.list(requestContext(c)) }))
  app.get('/api/workflows/:id/versions', async (c) => c.json({ versions: await services.workflows.listVersions(requestContext(c), c.req.param('id')) }))
  app.get('/api/workflows/:id', async (c) => c.json(await services.workflows.require(
    requestContext(c), c.req.param('id'), c.req.query('version') ? Number(c.req.query('version')) : undefined,
  )))
  app.post('/api/workflows', async (c) => {
    const body = z.object({
      workflow: workflowSchema,
      changeSource: z.enum(['manual', 'agent', 'import', 'migration']).default('manual'), expectedVersion: z.number().int().nonnegative().optional(),
    }).parse(await c.req.json<unknown>())
    return c.json(await services.workflows.save(requestContext(c), body.workflow, body.changeSource, body.expectedVersion), 201)
  })
  app.delete('/api/workflows/:id', async (c) => {
    const context = requestContext(c)
    const body = z.object({ expectedVersion: z.number().int().positive().optional() }).strict().parse(await c.req.json<unknown>())
    const archived = await services.workflows.archive(context, c.req.param('id'), body.expectedVersion)
    if (!archived) throw new AppError('workflow_not_found', 404, 'Workflowが見つかりません。')
    await services.audit.record(context, { type: 'workflow.archived', outcome: 'success', resourceType: 'workflow',
      resourceId: c.req.param('id'), summary: { version: body.expectedVersion } })
    return c.json({ archived: true })
  })
  app.post('/api/workflows/:id/run-approvals', async (c) => {
    const context = requestContext(c)
    if (!canRun(context) || !canExport(context)) throw new AppError('workflow_run_export_denied', 403, 'CSV出力を含むWorkflowを実行する権限がありません。')
    const body = z.object({ version: z.number().int().positive().optional() }).strict().parse(await c.req.json<unknown>())
    const saved = await services.workflows.require(context, c.req.param('id'), body.version)
    if (!saved.validation.valid) throw new AppError('workflow_not_ready', 409, '設定不足のWorkflowは実行できません。', saved.validation.errors)
    const outputSteps = saved.workflow.steps.filter((step) => step.kind === 'csv')
    if (outputSteps.length === 0) throw new AppError('approval_not_required', 409, 'このWorkflowには承認対象のCSV出力がありません。')
    const action = { type: 'workflow_run_export' as const, workflowId: saved.workflow.id, version: saved.version,
      contentHash: saved.contentHash, outputStepIds: outputSteps.map((step) => step.id) }
    const approval = await services.approvals.issue(context, action, {
      workflowName: saved.workflow.name, version: saved.version, outputFiles: outputSteps.map((step) => step.config.fileName),
      dataDestination: 'このWorkspace内の暗号化された成果物保管領域', externalTransmission: 'なし', oneTime: true,
    })
    await services.audit.record(context, { type: 'approval.issued', outcome: 'success', resourceType: 'workflow',
      resourceId: saved.workflow.id, summary: { action: action.type, approvalId: approval.id, version: saved.version } })
    return c.json(approval, 201)
  })
  app.post('/api/workflows/:id/runs', async (c) => {
    const context = requestContext(c)
    if (!canRun(context)) throw new AppError('workflow_run_denied', 403, 'Workflowを実行する権限がありません。')
    const body = z.object({
      version: z.number().int().positive().optional(),
      approvalId: z.string().min(1).optional(),
      conversationId: z.string().min(1).optional(),
    }).strict().parse(await c.req.json<unknown>())
    const saved = await services.workflows.require(context, c.req.param('id'), body.version)
    if (!saved.validation.valid) throw new AppError('workflow_not_ready', 409, '設定不足のWorkflowは実行できません。', saved.validation.errors)
    const outputStepIds = saved.workflow.steps.filter((step) => step.kind === 'csv').map((step) => step.id)
    if (outputStepIds.length > 0) {
      if (!body.approvalId || !canExport(context)) throw new AppError('approval_required', 403, 'CSV出力の内容を確認して承認してください。')
      await services.approvals.consume(context, body.approvalId, { type: 'workflow_run_export', workflowId: saved.workflow.id,
        version: saved.version, contentHash: saved.contentHash, outputStepIds })
      await services.audit.record(context, { type: 'approval.consumed', outcome: 'success', resourceType: 'workflow',
        resourceId: saved.workflow.id, summary: { action: 'workflow_run_export', approvalId: body.approvalId, version: saved.version } })
    } else if (body.approvalId) {
      throw new AppError('approval_not_applicable', 400, 'このWorkflow実行に承認IDは使用できません。')
    }
    const run = await services.runs.execute(context, saved.workflow.id, saved.version, saved.contentHash, body.approvalId)
    if (body.conversationId) {
      await services.conversations.appendSystemEvent(context, {
        conversationId: body.conversationId,
        deduplicationId: `workflow-run:${run.id}`,
        content: `「${saved.workflow.name}」を実行しました。`,
        metadata: { type: 'workflow_run', run },
        workflowId: saved.workflow.id,
        workflowVersion: saved.version,
      })
    }
    await services.audit.record(context, { type: 'workflow.run', outcome: 'success', resourceType: 'workflow',
      resourceId: c.req.param('id'), summary: { runId: run.id, durationMs: run.durationMs, steps: run.steps.length } })
    return c.json({ run }, 201)
  })
  app.post('/api/agent/respond', async (c) => {
    const result = await orchestrateAgentRequest(services, requestContext(c), agentRequestSchema.parse(await c.req.json<unknown>()))
    return c.json(result)
  })
  app.post('/api/agent/respond/stream', async (c) => {
    const context = requestContext(c)
    const input = agentRequestSchema.parse(await c.req.json<unknown>())
    return streamSSE(c, async (stream) => {
      let pendingWrite = Promise.resolve()
      const write = (event: string, value: unknown) => {
        pendingWrite = pendingWrite.then(() => stream.writeSSE({ event, data: JSON.stringify(value) }))
        return pendingWrite
      }
      try {
        const result = await orchestrateAgentRequest(services, context, input, (activity) => write('activity', activity))
        await write('response', result)
      } catch (error) {
        const problem = toProblemDetails(error, context.requestId)
        logRequestFailure(config, error, problem)
        await write('error', problem)
      }
    })
  })
  app.get('/api/conversations/:id', async (c) =>
    c.json(browserConversation(await services.conversations.require(requestContext(c), c.req.param('id')))))
  app.post('/api/conversations/:id/workflow-link', async (c) => {
    const context = requestContext(c)
    const body = z.object({ workflowId: z.string().min(1), workflowVersion: z.number().int().positive() }).strict()
      .parse(await c.req.json<unknown>())
    await services.workflows.require(context, body.workflowId, body.workflowVersion)
    return c.json(await services.conversations.linkWorkflow(context, c.req.param('id'), body.workflowId, body.workflowVersion))
  })
  app.get('/api/runs', async (c) => c.json({ runs: await services.runs.list(requestContext(c)) }))
  app.get('/api/artifacts', async (c) => c.json({ artifacts: await services.artifacts.list(requestContext(c)) }))
  app.post('/api/workflows/:id/export-approvals', async (c) => {
    const context = requestContext(c)
    if (!canExport(context)) throw new AppError('workflow_export_denied', 403, 'Workflowをexportする権限がありません。')
    const body = z.object({ version: z.number().int().positive().optional() }).strict().parse(await c.req.json<unknown>())
    const { saved } = await services.transfers.prepare(context, c.req.param('id'), body.version)
    const action = { type: 'workflow_export' as const, workflowId: saved.workflow.id, version: saved.version, contentHash: saved.contentHash }
    return c.json(await services.approvals.issue(context, action, {
      workflowName: saved.workflow.name, version: saved.version, steps: saved.workflow.steps.length,
      includes: 'workflow-definition-only', excludes: 'connections,secrets,artifacts,sessions,memberships',
    }), 201)
  })
  app.post('/api/workflows/:id/export', async (c) => {
    const context = requestContext(c)
    if (!canExport(context)) throw new AppError('workflow_export_denied', 403, 'Workflowをexportする権限がありません。')
    const body = z.object({ version: z.number().int().positive(), approvalId: z.string().min(1) }).strict().parse(await c.req.json<unknown>())
    const { saved, transfer } = await services.transfers.prepare(context, c.req.param('id'), body.version)
    await services.approvals.consume(context, body.approvalId, { type: 'workflow_export', workflowId: saved.workflow.id,
      version: saved.version, contentHash: saved.contentHash })
    await services.audit.record(context, { type: 'workflow.export', outcome: 'success', resourceType: 'workflow',
      resourceId: saved.workflow.id, summary: { version: saved.version, steps: saved.workflow.steps.length } })
    return c.json(transfer)
  })
  app.post('/api/workflows/import', async (c) => {
    const context = requestContext(c)
    const imported = await services.transfers.import(context, await c.req.json<unknown>())
    await services.audit.record(context, { type: 'workflow.import', outcome: 'success', resourceType: 'workflow',
      resourceId: imported.saved.workflow.id, summary: { unresolvedConnections: imported.unresolvedConnections.length } })
    return c.json(imported, 201)
  })
  app.post('/api/uploads/:format', async (c) => {
    const context = dataSourceAdminContext(c)
    const format = z.enum(['json', 'csv']).parse(c.req.param('format'))
    const sourceId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/).parse(c.req.query('sourceId'))
    const sourceName = z.string().min(1).max(100).parse(c.req.query('sourceName'))
    const uploaded = await services.backend.uploadAndRegister(context, {
      format,
      filename: c.req.query('filename'),
      contentType: c.req.header('Content-Type') ?? '',
      bytes: new Uint8Array(await c.req.arrayBuffer()),
      sourceId,
      sourceName,
    })
    await services.audit.record(context, { type: 'upload.ingested', outcome: 'success', resourceType: 'artifact',
      resourceId: uploaded.artifact.id, summary: {
        format,
        bytes: Number(c.req.header('Content-Length') ?? 0),
        rows: uploaded.artifact.rowCount,
      } })
    return c.json({ ...uploaded, capability: dataSourceCapability(uploaded.source) }, 201)
  })
  app.post('/api/artifacts/:id/download-approvals', async (c) => {
    const context = requestContext(c)
    if (!canExport(context)) throw new AppError('artifact_download_denied', 403, 'Artifactをダウンロードする権限がありません。')
    const artifact = await services.artifacts.get(context, c.req.param('id'))
    if (!artifact || artifact.type !== 'csv') throw new AppError('artifact_not_found', 404, 'CSV成果物が見つかりません。')
    const approval = await services.approvals.issue(context, { type: 'artifact_download', artifactId: artifact.id, checksum: artifact.checksum }, {
      artifactName: artifact.name, rows: artifact.rowCount, classification: artifact.classification,
      destination: 'ログイン中の端末', checksum: artifact.checksum,
    })
    await services.audit.record(context, { type: 'approval.issued', outcome: 'success', resourceType: 'artifact', resourceId: artifact.id,
      summary: { action: 'artifact_download', approvalId: approval.id } })
    return c.json(approval, 201)
  })
  app.post('/api/artifacts/:id/download', async (c) => {
    const context = requestContext(c)
    if (!canExport(context)) throw new AppError('artifact_download_denied', 403, 'Artifactをダウンロードする権限がありません。')
    const body = z.object({ approvalId: z.string().min(1) }).strict().parse(await c.req.json<unknown>())
    const artifact = await services.artifacts.get(context, c.req.param('id'))
    if (!artifact?.content || artifact.type !== 'csv') throw new AppError('artifact_not_found', 404, '成果物が見つかりません。')
    await services.approvals.consume(context, body.approvalId, { type: 'artifact_download', artifactId: artifact.id, checksum: artifact.checksum })
    await services.audit.record(context, { type: 'artifact.download', outcome: 'success', resourceType: 'artifact', resourceId: artifact.id,
      summary: { approvalId: body.approvalId, rows: artifact.rowCount, bytes: artifact.content.byteLength } })
    return new Response(artifact.content as BodyInit, { headers: {
      'Content-Type': artifact.mimeType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${artifact.name}"`,
      'X-Content-Type-Options': 'nosniff',
    } })
  })

  if (process.env.NODE_ENV === 'production') {
    app.use('/*', serveStatic({ root: './dist/client' }))
    app.get('*', serveStatic({ path: './dist/client/index.html' }))
  }
  return app
}
