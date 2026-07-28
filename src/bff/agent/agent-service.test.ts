import { describe, expect, it, vi } from 'vitest'
import type { AgentModelInput, AgentModelProvider, AgentModelResponse } from './provider'
import { AgentService } from './agent-service'
import { sampleWorkflow, type Workflow } from '../../shared/workflow'
import { AppError } from '../../shared/errors'

const input: AgentModelInput = {
  message: '地域別に集計', workflow: sampleWorkflow, history: [],
  workflowExecution: { available: false, workflowId: sampleWorkflow.id, requiresApproval: false },
  dataSources: [{ id: 'sales', name: '売上', type: 'database-table', dataModel: 'table' }],
  catalogs: [{ sourceId: 'sales', version: 1, scope: 'canonical', definition: {
    sourceId: 'sales', displayName: '売上', description: '', policy: 'curated', classification: 'internal', dataModel: 'table', defaultTimeField: null,
    fields: [
      { path: 'region', dataTypes: ['string'], nullable: false, presence: 1, repeated: false, businessName: '', description: '', unit: '', timezone: '' },
      { path: 'category', dataTypes: ['string'], nullable: false, presence: 1, repeated: false, businessName: '', description: '', unit: '', timezone: '' },
      { path: 'amount', dataTypes: ['number'], nullable: false, presence: 1, repeated: false, businessName: '', description: '', unit: '', timezone: '' },
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
  return { metadata: { provider: 'openai-compatible' }, respond: async () => response }
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

  it('retries one rejected proposal with the BFF validation errors and accepts the repaired Workflow', async () => {
    const invalid = { ...workflow, steps: workflow.steps.map((step) => step.kind === 'aggregate'
      ? { ...step, config: { ...step.config, groupBy: 'category, sales_channel' } } : step) } as Workflow
    const respond = vi.fn<AgentModelProvider['respond']>()
      .mockResolvedValueOnce(proposal(invalid))
      .mockResolvedValueOnce(proposal(workflow))
    const service = new AgentService({ metadata: { provider: 'openai-compatible' }, respond })

    await expect(service.respond(input)).resolves.toMatchObject({ state: 'proposal', workflow })
    expect(respond).toHaveBeenCalledTimes(2)
    expect(respond.mock.calls[1]?.[0].currentTurn?.proposalValidationErrors).toEqual([
      '「地域別集計」のグループ列「category, sales_channel」は入力のData Catalogにありません。',
    ])
  })

  it('does not retry provider availability failures or other side-effect-adjacent errors', async () => {
    const respond = vi.fn<AgentModelProvider['respond']>().mockRejectedValue(
      new AppError('agent_provider_unreachable', 503, '接続できません。', undefined, true))
    const service = new AgentService({ metadata: { provider: 'openai-compatible' }, respond })

    await expect(service.respond(input)).rejects.toMatchObject({ code: 'agent_provider_unreachable' })
    expect(respond).toHaveBeenCalledOnce()
  })

  it('accepts a filtered whole-table row count without an artificial grouping field', async () => {
    const countWorkflow: Workflow = {
      version: 1, id: 'wf-hardware-count', name: 'Hardware件数', description: '', steps: [
        { id: 'sales', kind: 'query', title: '売上取得', config: { source: 'sales', parameters: {} } },
        { id: 'hardware', kind: 'filterSelect', title: 'Hardwareに絞り込み', input: 'sales',
          config: { columns: [], filters: [{ field: 'category', operator: 'eq', value: 'Hardware' }] } },
        { id: 'count', kind: 'aggregate', title: '行数を集計', input: 'hardware',
          config: { groupBy: null, metric: null, operation: 'count' } },
        { id: 'preview', kind: 'preview', title: '結果を表示', input: 'count', config: { limit: 1 } },
      ],
    }

    await expect(new AgentService(provider(proposal(countWorkflow))).respond(input))
      .resolves.toMatchObject({ state: 'proposal' })
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

  it('requires the Agent to make Documents-to-Table parsing explicit before aggregation', async () => {
    const documentInput: AgentModelInput = {
      ...input,
      dataSources: [{ id: 'events', name: 'イベント', type: 'database-documents', dataModel: 'documents' }],
      catalogs: [{ sourceId: 'events', version: 1, scope: 'personal', definition: {
        sourceId: 'events', displayName: 'イベント', description: '', policy: 'evolving',
        classification: 'internal', dataModel: 'documents', defaultTimeField: null,
        fields: [
          { path: 'region', dataTypes: ['string'], nullable: false, presence: 1, repeated: false,
            businessName: '', description: '', unit: '', timezone: '' },
          { path: 'amount', dataTypes: ['number'], nullable: false, presence: 1, repeated: false,
            businessName: '', description: '', unit: '', timezone: '' },
        ],
        relationships: [],
      } }],
    }
    const invalid: Workflow = {
      version: 1, id: 'wf-documents-invalid', name: 'Invalid', description: '', steps: [
        { id: 'events', kind: 'query', title: 'イベント取得', config: { source: 'events', parameters: {} } },
        { id: 'sum', kind: 'aggregate', title: '地域別集計', input: 'events',
          config: { groupBy: 'region', metric: 'amount', operation: 'sum' } },
      ],
    }
    const documentProposal = (candidate: Workflow): Extract<AgentModelResponse, { state: 'proposal' }> => ({
      ...proposal(candidate),
      plan: { summary: 'イベント集計', dataSources: [{ id: 'events', name: 'イベント' }],
        steps: candidate.steps.map((step) => ({ title: step.title, description: step.title })), warnings: [] },
    })
    await expect(new AgentService(provider(documentProposal(invalid))).respond(documentInput)).rejects.toMatchObject({
      code: 'agent_invalid_workflow', status: 502,
    })

    const valid: Workflow = {
      ...invalid,
      id: 'wf-documents-valid',
      steps: [
        invalid.steps[0]!,
        { id: 'parse', kind: 'parseDocuments', title: '表形式に変換', input: 'events', config: {
          recordPath: '$',
          columns: [
            { name: 'region', path: '$.region', dataType: 'string' },
            { name: 'amount', path: '$.amount', dataType: 'number' },
          ],
          onMissing: 'null', onTypeMismatch: 'error',
        } },
        { ...invalid.steps[1]!, input: 'parse' } as Workflow['steps'][number],
      ],
    }
    await expect(new AgentService(provider(documentProposal(valid))).respond(documentInput))
      .resolves.toMatchObject({ state: 'proposal' })
  })
})
