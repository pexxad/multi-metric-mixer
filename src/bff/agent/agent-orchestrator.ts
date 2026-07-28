import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors'
import type { AgentResponse, AgentToolActivity, AgentWorkflowRun } from '../../shared/api'
import type { CatalogBundle, CatalogObservation, CatalogVersion } from '../../shared/catalog'
import type { RequestContext } from '../../shared/request-context'
import { canRun } from '../../shared/request-context'
import type { ArtifactSummary, Workflow } from '../../shared/workflow'
import { contentHash } from '../../shared/canonical-hash'
import type { BffServices } from '../runtime'
import { AgentMcpRunner } from './mcp-runner'
import type { AgentModelResponse, AgentToolResult } from './provider'
import {
  AGENT_TOOL_LOOP_MAX_MS,
  AGENT_TOOL_MAX_CALLS,
  AGENT_TOOL_RESULT_MAX_BYTES,
  AGENT_TOOL_RESULTS_MAX_BYTES,
  resultBytes,
  toolCallKey,
  validateAgentAuxiliaryToolResult,
  validateAgentToolCall,
  validateAgentToolResult,
  type AgentWorkflowExecutionTarget,
} from './tool-loop'

export type AgentRequest = {
  conversationId?: string
  clientMessageId: string
  message: string
  workflow: Workflow
}

function catalogContext(catalogs: CatalogVersion[]) {
  return catalogs.map(({ sourceId, version, scope, baseCanonicalVersion, definition }) => ({
    sourceId,
    version,
    scope,
    ...(baseCanonicalVersion ? { baseCanonicalVersion } : {}),
    definition,
  }))
}

function boundedJsonValue(value: unknown, depth = 0): import('../../shared/workflow').JsonValue {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (depth >= 4) return '[nested value omitted]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedJsonValue(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30)
    .map(([key, item]) => [key.slice(0, 128), boundedJsonValue(item, depth + 1)]))
  return String(value).slice(0, 500)
}

function conversationContext(messages: Array<{
  sequence: number
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: unknown
}>) {
  const history = messages.flatMap((message) => message.role === 'system'
    ? []
    : [{ role: message.role, content: message.content }])
  const priorResults = messages.flatMap((message) => {
    if (message.role !== 'assistant' || !message.metadata || typeof message.metadata !== 'object'
      || Array.isArray(message.metadata) || !('artifacts' in message.metadata)
      || !Array.isArray(message.metadata.artifacts)) return []
    const artifacts = message.metadata.artifacts.slice(0, 3).flatMap((artifact) => {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
        || !('type' in artifact) || !['documents', 'table', 'csv'].includes(String(artifact.type))
        || !('name' in artifact) || typeof artifact.name !== 'string'
        || !('rowCount' in artifact) || typeof artifact.rowCount !== 'number'
        || !('columns' in artifact) || !Array.isArray(artifact.columns)
        || !('createdAt' in artifact) || typeof artifact.createdAt !== 'string') return []
      return [{
        type: artifact.type as 'documents' | 'table' | 'csv',
        name: artifact.name.slice(0, 256),
        rowCount: artifact.rowCount,
        columns: artifact.columns.filter((column: unknown): column is string => typeof column === 'string').slice(0, 30),
        preview: 'preview' in artifact && Array.isArray(artifact.preview)
          ? artifact.preview.slice(0, 5).map((item: unknown) => boundedJsonValue(item)) : [],
        createdAt: artifact.createdAt,
      }]
    })
    return artifacts.length > 0 ? [{ messageSequence: message.sequence, artifacts }] : []
  }).slice(-5)
  return { history, priorResults }
}

export async function orchestrateAgentRequest(
  services: BffServices,
  context: RequestContext,
  input: AgentRequest,
  onActivity?: (activity: AgentToolActivity) => void | Promise<void>,
): Promise<AgentResponse> {
  const [conversation, sources, catalogs, workflowVersions] = await Promise.all([
    input.conversationId ? services.conversations.require(context, input.conversationId) : Promise.resolve(undefined),
    services.sources.list(context),
    services.catalogs.listEffective(context),
    services.workflows.listVersions(context, input.workflow.id).catch((error) => {
      if (error instanceof AppError && error.code === 'workflow_not_found') return []
      throw error
    }),
  ])
  const matchingWorkflow = workflowVersions.find((saved) => saved.contentHash === contentHash(input.workflow))
  const workflowExecution: AgentWorkflowExecutionTarget = {
    workflowId: input.workflow.id,
    workflowName: input.workflow.name,
    version: matchingWorkflow?.version ?? 0,
    available: Boolean(matchingWorkflow?.validation.valid && canRun(context)),
    requiresApproval: matchingWorkflow?.workflow.steps.some((step) => step.kind === 'csv') ?? false,
    ...(!canRun(context)
      ? { reason: '現在のWorkspace権限ではWorkflowを実行できません。' }
      : !matchingWorkflow
        ? { reason: '現在のWorkflowには保存済みの同一バージョンがありません。先にWorkflowを保存してください。' }
        : !matchingWorkflow.validation.valid
          ? { reason: `現在のWorkflowは設定が不足しています: ${matchingWorkflow.validation.errors.join(' ')}` }
          : {}),
  }
  const runner = new AgentMcpRunner(services.mcp, context, onActivity)
  const { history, priorResults } = conversationContext(conversation?.messages ?? [])
  let availableCatalogs = catalogs
  const currentTurnEvents: NonNullable<Parameters<typeof services.agent.respond>[0]['currentTurn']>['events'] = []
  const toolResults: AgentToolResult[] = []
  const seenToolCalls = new Set<string>()
  const toolLoopStartedAt = performance.now()
  let toolResultBytes = 0
  const modelInput = (extra: Partial<Parameters<typeof services.agent.respond>[0]> = {}) => ({
    message: input.message,
    workflow: input.workflow,
    workflowExecution: {
      available: workflowExecution.available,
      workflowId: workflowExecution.workflowId,
      ...(workflowExecution.version > 0 ? { version: workflowExecution.version } : {}),
      requiresApproval: workflowExecution.requiresApproval,
      ...(workflowExecution.reason ? { reason: workflowExecution.reason } : {}),
    },
    dataSources: sources,
    catalogs: catalogContext(availableCatalogs),
    history,
    ...(priorResults.length ? { priorResults } : {}),
    currentTurn: { events: currentTurnEvents.map((event) => ({ ...event, sourceIds: [...event.sourceIds] })) },
    ...(toolResults.length ? { toolResults: toolResults.map((item) => ({ ...item, input: { ...item.input } })) } : {}),
    ...extra,
  })
  const runToolLoop = async (initial: AgentModelResponse): Promise<Exclude<AgentModelResponse, { state: 'tool' }>> => {
    let decision: AgentModelResponse = initial
    while (decision.state === 'tool') {
      if (toolResults.length >= AGENT_TOOL_MAX_CALLS) {
        throw new AppError('agent_tool_limit_exceeded', 502,
          '分析に必要なMCPツール呼び出しが上限を超えました。依頼を分けて再度お試しください。', undefined, true)
      }
      if (performance.now() - toolLoopStartedAt > AGENT_TOOL_LOOP_MAX_MS) {
        throw new AppError('agent_tool_loop_timeout', 504,
          '分析のためのMCPツール処理が時間内に完了しませんでした。再度お試しください。', undefined, true)
      }
      const call = validateAgentToolCall(decision, sources, toolResults, workflowExecution)
      const key = toolCallKey(call)
      if (seenToolCalls.has(key)) {
        toolResults.push({
          callId: randomUUID(),
          tool: call.tool,
          input: call.input,
          error: '同じMCPツールと入力は今回の依頼ですでに実行済みです。既存のresultを使用し、別のtoolまたは最終回答を選択してください。',
        })
        decision = await services.agent.respond(modelInput())
        continue
      }
      seenToolCalls.add(key)
      const item: AgentToolResult = { callId: randomUUID(), tool: call.tool, input: call.input }
      try {
        let bytes = 0
        item.result = await runner.call<unknown>(call.tool, call.label, call.input, (result) => {
          validateAgentToolResult(call.tool, result)
          bytes = resultBytes(result)
          if (bytes > AGENT_TOOL_RESULT_MAX_BYTES || toolResultBytes + bytes > AGENT_TOOL_RESULTS_MAX_BYTES) {
            throw new AppError('agent_tool_result_too_large', 502,
              'MCPツールの結果が大きすぎます。対象や件数を絞って再度お試しください。', undefined, true)
          }
        })
        toolResultBytes += bytes
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'mcp_tool_error') throw error
        item.error = error.message
      }
      toolResults.push(item)
      decision = await services.agent.respond(modelInput())
    }
    return decision
  }
  let response = await runToolLoop(await services.agent.respond(modelInput()))

  if (response.state === 'exploration') {
    const allowedSources = new Map(sources.map((source) => [source.id, source]))
    const requested = [...new Set(response.sourceIds)].map((id) => allowedSources.get(id))
    if (requested.some((source) => !source)) {
      throw new AppError('agent_unknown_data_source', 400, 'Agentが未登録のデータソースを探索しようとしました。')
    }
    const requestedSources = requested.filter((source): source is NonNullable<typeof source> => source !== undefined)
    const profiles = await Promise.all(requestedSources.map((source) =>
      runner.call<{
        observation: CatalogObservation
        catalog: Awaited<ReturnType<typeof services.catalogs.savePersonal>>
        artifact: ArtifactSummary
      }>('catalog_explore_personal', `「${source.name}」のデータ構造を探索`, { source: source.id, limit: 100 },
        (result) => validateAgentAuxiliaryToolResult('catalog_explore_personal', result))))
    const observations = profiles.map(({ catalog }) => catalog)
    const refreshedCatalogs = await services.catalogs.listEffective(context)
    availableCatalogs = refreshedCatalogs
    await services.audit.record(context, {
      type: 'agent.catalog.explored',
      outcome: 'success',
      resourceType: 'conversation',
      resourceId: conversation?.id,
      summary: {
        sources: observations.map((catalog) => catalog.sourceId),
        fields: observations.reduce((sum, catalog) => sum + catalog.definition.fields.length, 0),
      },
    })
    currentTurnEvents.push({
      type: 'catalog_explored',
      sourceIds: observations.map((catalog) => catalog.sourceId),
      savedTo: 'personal-catalog',
    })
    response = await runToolLoop(await services.agent.respond(modelInput({
      catalogs: catalogContext(refreshedCatalogs),
    })))
  }

  if (response.state === 'answer') {
    const previewedArtifactIds = new Set(toolResults.flatMap((item) =>
      item.tool === 'artifact_preview' && typeof item.input.artifactId === 'string'
        ? [item.input.artifactId] : []))
    const samplesWithoutPreview = toolResults.flatMap((item) => {
      if (item.tool !== 'data_source_sample' || !item.result || typeof item.result !== 'object'
        || Array.isArray(item.result) || !('id' in item.result) || typeof item.result.id !== 'string'
        || previewedArtifactIds.has(item.result.id)) return []
      const requestedLimit = typeof item.input.limit === 'number' ? item.input.limit : 5
      return [{ artifactId: item.result.id, limit: Math.max(1, Math.min(5, requestedLimit)) }]
    })
    for (const sample of samplesWithoutPreview) {
      response = await runToolLoop({
        state: 'tool',
        message: '取得したサンプルへ表示用の安全処理を適用します。',
        changes: [],
        tool: 'artifact_preview',
        sourceId: '',
        artifactId: sample.artifactId,
        limit: sample.limit,
        reason: 'サンプル内容を最終回答へ含める前に必須のプレビュー処理を適用するためです。',
      })
      if (response.state !== 'answer') {
        throw new AppError('agent_invalid_tool_followup', 502,
          '分析エージェントがプレビュー結果を最終回答として処理できませんでした。再度お試しください。', undefined, true)
      }
    }
  }

  let answerCatalogs: Extract<AgentResponse, { state: 'answer' }>['catalogs'] = []
  let answerArtifacts: Extract<AgentResponse, { state: 'answer' }>['artifacts'] = []
  let workflowRuns: AgentWorkflowRun[] = []
  if (response.state === 'answer') {
    workflowRuns = toolResults.flatMap((item) =>
      item.tool === 'workflow_execute' && item.result
        ? [item.result as AgentWorkflowRun] : [])
    const workflowExecuted = workflowRuns.length > 0
    const allowedSources = new Map(sources.map((source) => [source.id, source]))
    // Exact IDs in the current request are a deterministic fallback for models
    // that omit sourceIds. This does not infer or broaden data access.
    const exactMentions = sources.filter((source) => input.message.includes(source.id)).map((source) => source.id)
    const requestedIds = [...new Set([...response.sourceIds, ...exactMentions])]
    const unknown = requestedIds.find((id) => !allowedSources.has(id))
    if (unknown) throw new AppError('agent_unknown_data_source', 400, 'Agentが未登録のデータソースを参照しようとしました。')
    if (!workflowExecuted) {
      for (const sourceId of requestedIds) {
        const described = toolResults.some((item) =>
          item.tool === 'catalog_describe' && item.input.sourceId === sourceId && item.result !== undefined)
        if (described) continue
        response = await runToolLoop({
          state: 'tool',
          message: `${sourceId}のData Catalogを確認します。`,
          changes: [],
          tool: 'catalog_describe',
          sourceId,
          artifactId: '',
          limit: 0,
          reason: 'データソース固有の回答をMCP結果で検証するためです。',
        })
        if (response.state !== 'answer') {
          throw new AppError('agent_invalid_tool_followup', 502,
            '分析エージェントがMCP結果を最終回答として処理できませんでした。再度お試しください。', undefined, true)
        }
      }
    }
    const bundles = toolResults.flatMap((item) =>
      item.tool === 'catalog_describe' && item.result ? [item.result as CatalogBundle] : [])
    answerCatalogs = workflowExecuted ? [] : bundles.flatMap((bundle) => {
      const catalog = bundle.effective
      return catalog ? [{
        sourceId: catalog.sourceId,
        displayName: catalog.definition.displayName,
        description: catalog.definition.description,
        dataModel: catalog.definition.dataModel,
        scope: catalog.scope,
        version: catalog.version,
        fields: catalog.definition.fields,
        relationships: catalog.definition.relationships,
      }] : []
    })
    const artifacts = toolResults.flatMap((item) => {
      if (!item.result || !['data_source_sample', 'artifact_preview'].includes(item.tool)) return []
      const artifact = item.result as Partial<ArtifactSummary>
      return typeof artifact.id === 'string' && ['documents', 'table', 'csv'].includes(String(artifact.type))
        ? [artifact as ArtifactSummary] : []
    })
    const previewIds = new Set(toolResults.filter((item) => item.tool === 'artifact_preview')
      .flatMap((item) => item.result && typeof item.result === 'object' && 'id' in item.result
        ? [String(item.result.id)] : []))
    const workflowArtifacts = workflowRuns.map((run) => run.finalArtifact)
    const selectedArtifacts = previewIds.size > 0 ? artifacts.filter((artifact) => previewIds.has(artifact.id)) : artifacts
    answerArtifacts = [...new Map([...workflowArtifacts, ...selectedArtifacts].map((artifact) => [artifact.id, artifact])).values()]
    response = { ...response, sourceIds: [...new Set([...response.sourceIds, ...requestedIds])] }
  }

  const responseMetadata = response.state === 'answer'
      ? { ...response, catalogs: answerCatalogs, artifacts: answerArtifacts, toolCalls: runner.activities,
        ...(workflowRuns.at(-1) ? { workflowRun: workflowRuns.at(-1) } : {}) }
      : { ...response, toolCalls: runner.activities }
  const savedConversation = await services.conversations.appendExchange(context, {
    conversationId: conversation?.id,
    title: conversation?.title ?? input.message.slice(0, 80),
    clientMessageId: input.clientMessageId,
    userMessage: input.message,
    assistantMessage: response.message,
    assistantMetadata: responseMetadata,
  })
  await services.audit.record(context, {
    type: 'agent.responded',
    outcome: 'success',
    resourceType: 'conversation',
    resourceId: savedConversation.id,
    summary: { state: response.state, provider: services.agent.model.metadata.provider, toolCalls: runner.activities.length },
  })
  return { ...responseMetadata, conversationId: savedConversation.id }
}
