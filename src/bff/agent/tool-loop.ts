import { z } from 'zod'
import { AppError } from '../../shared/errors'
import { catalogDefinitionSchema, catalogObservationSchema } from '../../shared/catalog'
import type { DataSourceCapability } from '../../shared/data-source'
import type { ArtifactSummary } from '../../shared/workflow'
import type { AgentDecision, AgentToolResult } from './provider'

export const AGENT_TOOL_MAX_CALLS = 6
export const AGENT_TOOL_LOOP_MAX_MS = 180_000
export const AGENT_TOOL_RESULT_MAX_BYTES = 256 * 1024
export const AGENT_TOOL_RESULTS_MAX_BYTES = 768 * 1024

type ToolDecision = Extract<AgentDecision, { state: 'tool' }>

const dataSourceDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  dataModel: z.enum(['table', 'documents']),
}).passthrough()

const artifactSummarySchema = z.object({
  id: z.string(),
  type: z.enum(['documents', 'table', 'csv']),
  name: z.string(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  preview: z.array(z.json()).optional(),
  provenance: z.array(z.string()),
  trustLevel: z.literal('untrusted'),
  classification: z.enum(['internal', 'confidential', 'restricted']),
  checksum: z.string(),
  createdAt: z.string(),
}).passthrough()

const workflowRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: z.enum(['completed', 'failed']),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  finalArtifact: artifactSummarySchema,
}).passthrough()

const catalogVersionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  scope: z.enum(['canonical', 'personal']),
  version: z.number().int().positive(),
  definition: catalogDefinitionSchema,
  schemaFingerprint: z.string(),
  createdAt: z.string(),
}).passthrough()

const toolResultSchemas = {
  data_source_list: z.object({ sources: z.array(dataSourceDescriptorSchema) }).passthrough(),
  data_source_describe: dataSourceDescriptorSchema,
  catalog_describe: z.object({
    sourceId: z.string(),
    canonical: catalogVersionSchema.optional(),
    personal: catalogVersionSchema.optional(),
    effective: catalogVersionSchema.optional(),
    personalOutdated: z.boolean(),
  }).passthrough(),
  data_source_sample: artifactSummarySchema,
  artifact_preview: artifactSummarySchema,
  workflow_execute: workflowRunSchema,
} satisfies Record<ToolDecision['tool'], z.ZodType>

const auxiliaryToolResultSchemas = {
  catalog_explore_personal: z.object({
    observation: catalogObservationSchema,
    catalog: catalogVersionSchema,
    artifact: artifactSummarySchema,
  }).passthrough(),
}

export type AgentWorkflowExecutionTarget = {
  workflowId: string
  workflowName: string
  version: number
  available: boolean
  requiresApproval: boolean
  reason?: string
}

export type ValidatedAgentToolCall = {
  tool: ToolDecision['tool']
  input: Record<string, unknown>
  label: string
}

function requireSource(sources: DataSourceCapability[], sourceId: string): DataSourceCapability {
  const source = sources.find((item) => item.id === sourceId)
  if (!source) throw new AppError('agent_unknown_data_source', 400,
    '分析エージェントが未登録のデータソースを指定しました。')
  return source
}

function artifactIds(results: AgentToolResult[]): Set<string> {
  const ids = new Set<string>()
  for (const item of results) {
    if (!item.result || typeof item.result !== 'object' || Array.isArray(item.result)) continue
    const result = item.result as Partial<ArtifactSummary>
    if (typeof result.id === 'string' && ['documents', 'table', 'csv'].includes(String(result.type))) ids.add(result.id)
    const finalArtifact = (item.result as { finalArtifact?: Partial<ArtifactSummary> }).finalArtifact
    if (finalArtifact && typeof finalArtifact.id === 'string'
      && ['documents', 'table', 'csv'].includes(String(finalArtifact.type))) ids.add(finalArtifact.id)
  }
  return ids
}

export function validateAgentToolCall(
  decision: ToolDecision,
  sources: DataSourceCapability[],
  results: AgentToolResult[],
  workflowExecution?: AgentWorkflowExecutionTarget,
): ValidatedAgentToolCall {
  if (decision.tool === 'data_source_list') {
    return { tool: decision.tool, input: {}, label: '利用可能なデータソースを取得' }
  }
  if (decision.tool === 'workflow_execute') {
    if (!workflowExecution?.available) {
      throw new AppError('agent_workflow_not_executable', 409,
        workflowExecution?.reason ?? '現在のWorkflowは保存されていないため実行できません。')
    }
    if (workflowExecution.requiresApproval) {
      throw new AppError('approval_required', 403,
        'CSV出力を含むWorkflowは、画面の「Workflowを実行」から内容を確認して承認してください。')
    }
    return {
      tool: decision.tool,
      input: { workflowId: workflowExecution.workflowId, version: workflowExecution.version },
      label: `Workflow「${workflowExecution.workflowName}」v${workflowExecution.version}を実行`,
    }
  }
  if (decision.tool === 'artifact_preview') {
    if (!artifactIds(results).has(decision.artifactId)) {
      throw new AppError('agent_invalid_tool_reference', 400,
        '分析エージェントが今回の処理で生成されていないArtifactを参照しました。')
    }
    if (decision.limit < 1) throw new AppError('agent_invalid_tool_input', 400,
      'Artifactのプレビュー件数が指定されていません。')
    return {
      tool: decision.tool,
      input: { artifactId: decision.artifactId, config: { limit: decision.limit } },
      label: '取得したデータを安全にプレビュー',
    }
  }
  const source = requireSource(sources, decision.sourceId)
  if (decision.tool === 'data_source_describe') {
    return { tool: decision.tool, input: { source: source.id }, label: `「${source.name}」のmetadataを取得` }
  }
  if (decision.tool === 'catalog_describe') {
    return { tool: decision.tool, input: { sourceId: source.id }, label: `「${source.name}」のData Catalogを取得` }
  }
  if (decision.limit < 1) throw new AppError('agent_invalid_tool_input', 400,
    'サンプルの取得件数が指定されていません。')
  return {
    tool: decision.tool,
    input: { source: source.id, limit: decision.limit },
    label: `「${source.name}」からサンプルを取得`,
  }
}

export function toolCallKey(call: ValidatedAgentToolCall): string {
  return `${call.tool}:${JSON.stringify(call.input)}`
}

export function resultBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    throw new AppError('agent_invalid_tool_result', 502, 'MCPツールの結果を処理できませんでした。')
  }
}

export function validateAgentToolResult(tool: ToolDecision['tool'], value: unknown): void {
  const parsed = toolResultSchemas[tool].safeParse(value)
  if (!parsed.success) {
    throw new AppError('agent_invalid_tool_result', 502,
      'MCPツールが契約と異なる結果を返しました。', parsed.error.issues, true)
  }
}

export function validateAgentAuxiliaryToolResult(
  tool: keyof typeof auxiliaryToolResultSchemas,
  value: unknown,
): void {
  const parsed = auxiliaryToolResultSchemas[tool].safeParse(value)
  if (!parsed.success) {
    throw new AppError('agent_invalid_tool_result', 502,
      'MCPツールが契約と異なる結果を返しました。', parsed.error.issues, true)
  }
}
