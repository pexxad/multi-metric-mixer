import type { CatalogField, CatalogRelationship } from './catalog'
import type { ArtifactSummary, Workflow, WorkflowRun } from './workflow'

export type AgentQuestion = {
  id: string
  prompt: string
  choices: string[]
}

export type AgentPlan = {
  summary: string
  dataSources: Array<{ id: string; name: string }>
  steps: Array<{ title: string; description: string }>
  warnings: string[]
}

export type AgentWorkflowRun = Omit<WorkflowRun, 'steps'> & {
  stepCount: number
}

export type AgentToolActivity = {
  id: string
  tool: string
  label: string
  status: 'running' | 'completed' | 'failed'
  durationMs?: number
}

type AgentResponseBase = {
  message: string
  changes: string[]
  conversationId: string
  toolCalls: AgentToolActivity[]
}

export type AgentClarificationResponse = AgentResponseBase & {
  state: 'clarification'
  questions: AgentQuestion[]
}

export type AgentProposalResponse = AgentResponseBase & {
  state: 'proposal'
  workflow: Workflow
  plan: AgentPlan
}

export type AgentExplorationResponse = AgentResponseBase & {
  state: 'exploration'
  sourceIds: string[]
  reason: string
}

export type AgentUnsupportedResponse = AgentResponseBase & {
  state: 'unsupported'
  reason: string
}

export type AgentAnswerResponse = AgentResponseBase & {
  state: 'answer'
  sourceIds: string[]
  reason: string
  artifacts: ArtifactSummary[]
  workflowRun?: AgentWorkflowRun
  catalogs: Array<{
    sourceId: string
    displayName: string
    description: string
    dataModel: 'table' | 'documents'
    scope: 'canonical' | 'personal'
    version: number
    fields: CatalogField[]
    relationships: CatalogRelationship[]
  }>
}

export type AgentResponse = AgentAnswerResponse | AgentClarificationResponse | AgentExplorationResponse
  | AgentUnsupportedResponse | AgentProposalResponse
