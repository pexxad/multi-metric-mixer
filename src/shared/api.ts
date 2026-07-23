import type { ArtifactSummary, Workflow } from './workflow'

export type AgentProviderStatus = {
  provider: 'openai-compatible' | 'disabled'
  label: string
  configured: boolean
  model?: string
  transportSecurity?: 'https' | 'loopback-http' | 'private-http'
}

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

type AgentResponseBase = {
  message: string
  changes: string[]
  provider: AgentProviderStatus
  conversationId: string
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
  reason: string
}

export type AgentSampleResponse = AgentResponseBase & {
  state: 'sample'
  sourceIds: string[]
  limit: number
  reason: string
  artifact: ArtifactSummary
}

export type AgentResponse = AgentAnswerResponse | AgentSampleResponse | AgentClarificationResponse | AgentExplorationResponse
  | AgentUnsupportedResponse | AgentProposalResponse
