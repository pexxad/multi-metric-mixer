import { z } from 'zod'
import { workflowSchema } from '../../shared/workflow'
import type { CatalogDefinition } from '../../shared/catalog'
import type { AgentGenerationActivity } from '../../shared/api'

const questionSchema = z.object({
  id: z.string().min(1).max(64),
  prompt: z.string().min(1).max(500),
  choices: z.array(z.string().min(1).max(200)).max(6),
}).strict()

const planSchema = z.object({
  summary: z.string().min(1).max(2_000),
  dataSources: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).max(20),
  steps: z.array(z.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(1_000) }).strict()).min(1).max(20),
  warnings: z.array(z.string().min(1).max(500)).max(20),
}).strict()

const clarificationResponseSchema = z.object({
    state: z.literal('clarification'),
    message: z.string().min(1).max(20_000),
    changes: z.array(z.string().max(500)).max(100).default([]),
    questions: z.array(questionSchema).min(1).max(5),
  }).strict()

const explorationResponseSchema = z.object({
    state: z.literal('exploration'),
    message: z.string().min(1).max(20_000),
    changes: z.array(z.string().max(500)).max(100).default([]),
    sourceIds: z.array(z.string().min(1).max(64)).min(1).max(3),
    reason: z.string().min(1).max(2_000),
  }).strict()

const unsupportedResponseSchema = z.object({
  state: z.literal('unsupported'),
  message: z.string().min(1).max(20_000),
  changes: z.array(z.string().max(500)).max(100).default([]),
  reason: z.string().min(1).max(2_000),
}).strict()

const answerResponseSchema = z.object({
  state: z.literal('answer'),
  message: z.string().min(1).max(20_000),
  changes: z.array(z.string().max(500)).max(100).default([]),
  sourceIds: z.array(z.string().min(1).max(64)).max(3).default([]),
  reason: z.string().min(1).max(2_000),
}).strict()

export const agentToolNameSchema = z.enum([
  'data_source_list',
  'data_source_describe',
  'catalog_describe',
  'data_source_sample',
  'artifact_preview',
  'workflow_execute',
])

const toolResponseSchema = z.object({
  state: z.literal('tool'),
  message: z.string().min(1).max(20_000),
  changes: z.array(z.string().max(500)).max(100).default([]),
  tool: agentToolNameSchema,
  sourceId: z.string().max(64),
  artifactId: z.string().max(200),
  limit: z.number().int().min(0).max(5),
  reason: z.string().min(1).max(2_000),
}).strict()

export const agentProposalResponseSchema = z.object({
    state: z.literal('proposal'),
    message: z.string().min(1).max(20_000),
    changes: z.array(z.string().min(1).max(500)).min(1).max(100),
    workflow: workflowSchema,
    plan: planSchema,
  }).strict()

export const agentDecisionSchema = z.discriminatedUnion('state', [
  answerResponseSchema,
  toolResponseSchema,
  clarificationResponseSchema,
  explorationResponseSchema,
  unsupportedResponseSchema,
  z.object({
    state: z.literal('proposal'),
    message: z.string().min(1).max(20_000),
    changes: z.array(z.string().min(1).max(500)).min(1).max(100),
  }).strict(),
])

// OpenAI-compatible servers differ in which JSON Schema constructs their
// grammar engines accept. Keep the wire shape branch-free, then validate the
// selected state with the stricter domain schema below.
export const agentDecisionWireSchema = z.object({
  state: z.enum(['answer', 'tool', 'clarification', 'exploration', 'unsupported', 'proposal']),
  message: z.string().min(1).max(20_000),
  changes: z.array(z.string().max(500)).max(100),
  questions: z.array(questionSchema).max(5),
  sourceIds: z.array(z.string().min(1).max(64)).max(3),
  limit: z.number().int().min(0).max(5),
  reason: z.string().max(2_000),
  tool: z.enum(['none', ...agentToolNameSchema.options]),
  sourceId: z.string().max(64),
  artifactId: z.string().max(200),
}).strict()

export const agentAnswerWireSchema = agentDecisionWireSchema.extend({
  state: z.literal('answer'),
  tool: z.literal('none'),
}).strict()

export function parseAgentDecisionWire(value: z.infer<typeof agentDecisionWireSchema>): AgentDecision {
  if (value.state === 'tool') {
    if (value.tool === 'none') throw new z.ZodError([{
      code: 'custom', path: ['tool'], message: 'tool state requires a tool',
      input: value.tool,
    }])
    return agentDecisionSchema.parse({
      state: value.state, message: value.message, changes: value.changes, tool: value.tool,
      sourceId: value.sourceId, artifactId: value.artifactId, limit: value.limit,
      reason: value.reason.trim() || value.message,
    })
  }
  if (value.state === 'answer') return agentDecisionSchema.parse({
    state: value.state, message: value.message, changes: value.changes, sourceIds: value.sourceIds,
    reason: value.reason.trim() || value.message,
  })
  if (value.state === 'clarification') return agentDecisionSchema.parse({
    state: value.state, message: value.message, changes: value.changes, questions: value.questions,
  })
  if (value.state === 'exploration') return agentDecisionSchema.parse({
    state: value.state, message: value.message, changes: value.changes, sourceIds: value.sourceIds,
    reason: value.reason.trim() || value.message,
  })
  if (value.state === 'unsupported') return agentDecisionSchema.parse({
    state: value.state, message: value.message, changes: value.changes, reason: value.reason.trim() || value.message,
  })
  return agentDecisionSchema.parse({ state: value.state, message: value.message, changes: value.changes })
}

export const agentModelResponseSchema = z.discriminatedUnion('state', [
  answerResponseSchema,
  toolResponseSchema,
  clarificationResponseSchema,
  explorationResponseSchema,
  unsupportedResponseSchema,
  agentProposalResponseSchema,
])

export type AgentModelResponse = z.infer<typeof agentModelResponseSchema>
export type AgentDecision = z.infer<typeof agentDecisionSchema>
export type AgentToolName = z.infer<typeof agentToolNameSchema>
export type AgentToolResult = {
  callId: string
  tool: AgentToolName
  input: Record<string, unknown>
  result?: unknown
  error?: string
}

export type AgentCurrentTurnEvent = {
  type: 'catalog_explored'
  sourceIds: string[]
  savedTo: 'personal-catalog'
}

export type AgentPriorResult = {
  messageSequence: number
  artifacts: Array<{
    type: 'documents' | 'table' | 'csv'
    name: string
    rowCount: number
    columns: string[]
    preview: import('../../shared/workflow').JsonValue[]
    createdAt: string
  }>
}

export type AgentModelInput = {
  message: string
  workflow: z.infer<typeof workflowSchema>
  workflowExecution: {
    available: boolean
    workflowId: string
    version?: number
    requiresApproval: boolean
    reason?: string
  }
  dataSources: Array<{ id: string; name: string; type: string; dataModel: 'table' | 'documents'; version?: number;
    queryMode?: 'sample' | 'template-required'; queryTemplates?: Array<{
      id: string; name: string; description: string; outputDataModel: 'table' | 'documents'; outputFields: string[];
      variables: import('../../shared/query-template').QueryVariable[]
    }> }>
  catalogs: Array<{ sourceId: string; version: number; scope: 'canonical' | 'personal';
    baseCanonicalVersion?: number; definition: CatalogDefinition }>
  priorResults?: AgentPriorResult[]
  currentTurn?: {
    events: AgentCurrentTurnEvent[]
    proposalValidationErrors?: string[]
  }
  toolResults?: AgentToolResult[]
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

export type AgentModelMetadata = {
  provider: 'openai-compatible' | 'disabled'
  model?: string
  transportSecurity?: 'https' | 'loopback-http' | 'insecure-http'
}

export interface AgentModelProvider {
  readonly metadata: AgentModelMetadata
  respond(input: AgentModelInput, onGeneration?: (activity: AgentGenerationActivity) => void | Promise<void>): Promise<AgentModelResponse>
}
