import { describe, expect, it } from 'vitest'
import type { AgentModelInput, AgentModelProvider, AgentModelResponse } from './provider'
import { AgentService } from './agent-service'
import { sampleWorkflow, type Workflow } from '../../shared/workflow'

const input: AgentModelInput = {
  message: '地域別に集計', workflow: sampleWorkflow, history: [],
  dataSources: [{ id: 'sales', name: '売上', type: 'sql' }],
  catalogs: [{ sourceId: 'sales', version: 1, scope: 'canonical', definition: {
    sourceId: 'sales', displayName: '売上', description: '', policy: 'curated', classification: 'internal', defaultTimeField: null,
    fields: [
      { path: 'region', dataTypes: ['string'], nullable: false, presence: 1, businessName: '', description: '', unit: '', timezone: '' },
      { path: 'amount', dataTypes: ['number'], nullable: false, presence: 1, businessName: '', description: '', unit: '', timezone: '' },
    ], relationships: [],
  } }],
}

const workflow: Workflow = {
  version: 1, id: 'wf-agent', name: '地域別売上', description: '', steps: [
    { id: 'sales', kind: 'query', title: '売上取得', config: { source: 'sales', parameters: {} } },
    { id: 'summary', kind: 'aggregate', title: '地域別集計', input: 'sales', config: { groupBy: 'region', metric: 'amount', operation: 'sum' } },
    { id: 'rank', kind: 'sortLimit', title: '上位10件', input: 'summary', config: { sortBy: 'sum_amount', direction: 'desc', limit: 10 } },
    { id: 'preview', kind: 'preview', title: '表示', input: 'rank', config: { limit: 10 } },
  ],
}

function provider(response: AgentModelResponse): AgentModelProvider {
  return { metadata: { provider: 'openai-compatible', label: 'test', configured: true }, respond: async () => response }
}

function proposal(candidate: Workflow): Extract<AgentModelResponse, { state: 'proposal' }> {
  return { state: 'proposal', message: '提案', changes: ['変更'], workflow: candidate,
    plan: { summary: '地域別集計', dataSources: [{ id: 'sales', name: '売上' }],
      steps: [{ title: '集計', description: '集計します' }], warnings: [] } }
}

describe('AgentService proposal validation', () => {
  it('passes through an explicit unsupported response without creating a Workflow', async () => {
    await expect(new AgentService(provider({ state: 'unsupported', message: '更新は対応していません。', changes: [],
      reason: 'read-only' })).respond(input)).resolves.toMatchObject({ state: 'unsupported' })
  })

  it('accepts a proposal whose fields follow Catalog and transform outputs', async () => {
    await expect(new AgentService(provider(proposal(workflow))).respond(input)).resolves.toMatchObject({ state: 'proposal' })
  })

  it('rejects invented expressions and fields before showing a proposal', async () => {
    const invalid = { ...workflow, steps: workflow.steps.map((step) => step.kind === 'aggregate'
      ? { ...step, config: { ...step.config, metric: 'sum(amount)' } } : step) } as Workflow
    await expect(new AgentService(provider(proposal(invalid))).respond(input)).rejects.toMatchObject({
      code: 'agent_invalid_workflow', status: 502,
    })
  })

  it('rejects arbitrary source parameters invented in place of typed transform nodes', async () => {
    const invalid = { ...workflow, steps: workflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, parameters: { aggregate: 'sum(amount)' } } } : step) } as Workflow
    await expect(new AgentService(provider(proposal(invalid))).respond(input)).rejects.toMatchObject({
      code: 'agent_invalid_workflow', status: 502,
    })
  })
})
