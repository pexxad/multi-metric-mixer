import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ArtifactSummary, TableRow } from '../shared/workflow'
import {
  createEvaluationEnvironment,
  loadEvaluationPairs,
  type EvaluationPair,
} from '../../evaluations/mcp/v1/evaluation-environment'

function row(artifact: ArtifactSummary): TableRow {
  const value = artifact.preview?.[0]
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('evaluation_preview_row_missing')
  return value as TableRow
}

describe('MCP evaluation set v1', () => {
  let environment: Awaited<ReturnType<typeof createEvaluationEnvironment>>
  let toolTrace: string[] = []
  let mcp: <T>(tool: string, input: Record<string, unknown>) => Promise<T>
  let expected: Map<string, EvaluationPair>

  beforeAll(async () => {
    expected = new Map((await loadEvaluationPairs()).map((pair) => [pair.id, pair]))
    expect(expected.size).toBe(10)
    environment = await createEvaluationEnvironment()
    mcp = async <T,>(tool: string, input: Record<string, unknown>) => {
      toolTrace.push(tool)
      const result = await environment.callTool<{ structuredContent?: T }>(tool, input)
      if (result.structuredContent === undefined) throw new Error(`MCP tool ${tool} did not return structuredContent.`)
      return result.structuredContent
    }
  })

  afterAll(async () => environment.close())

  const read = (source: string) => mcp<ArtifactSummary>('data_source_read', { source, parameters: {}, template: null })
  const filter = (artifactId: string, filters: Array<Record<string, unknown>>) =>
    mcp<ArtifactSummary>('table_filter_select', { artifactId, config: { columns: [], filters } })
  const aggregate = (artifactId: string, groupBy: string, metric: string, operation: 'sum' | 'average') =>
    mcp<ArtifactSummary>('table_aggregate', { artifactId, config: { groupBy, metric, operation } })
  const sortPreview = async (artifactId: string, sortBy: string) => {
    const sorted = await mcp<ArtifactSummary>('table_sort_limit', {
      artifactId,
      config: { sortBy, direction: 'desc', limit: 1 },
    })
    return mcp<ArtifactSummary>('artifact_preview', { artifactId: sorted.id, config: { limit: 1 } })
  }
  const parseEvents = async (artifactId: string) => mcp<ArtifactSummary>('documents_to_table', {
    artifactId,
    config: {
      recordPath: '$',
      columns: [
        { name: 'region_id', path: '$.region_id', dataType: 'string' },
        { name: 'category', path: '$.category', dataType: 'string' },
        { name: 'event_type', path: '$.event_type', dataType: 'string' },
        { name: 'count', path: '$.count', dataType: 'number' },
        { name: 'device', path: '$.context.device', dataType: 'string' },
      ],
      onMissing: 'null',
      onTypeMismatch: 'error',
    },
  })

  const cases: Array<{ id: string; solve: () => Promise<string> }> = [
    {
      id: 'mcp-01',
      solve: async () => {
        const sales = await read('eval-sales')
        const completed = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'completed' }])
        const totals = await aggregate(completed.id, 'category', 'amount', 'sum')
        return String(row(await sortPreview(totals.id, 'sum_amount')).category)
      },
    },
    {
      id: 'mcp-02',
      solve: async () => {
        const sales = await read('eval-sales')
        const completed = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'completed' }])
        const regions = await read('eval-regions')
        const totals = await mcp<ArtifactSummary>('table_join_aggregate', {
          leftArtifactId: completed.id,
          rightArtifactId: regions.id,
          config: { leftKey: 'region_id', rightKey: 'region_id', groupBy: 'region_name', metric: 'amount', operation: 'sum' },
        })
        return String(row(await sortPreview(totals.id, 'sum_amount')).region_name)
      },
    },
    {
      id: 'mcp-03',
      solve: async () => {
        const sales = await read('eval-sales')
        const completed = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'completed' }])
        const averages = await aggregate(completed.id, 'sales_rep', 'amount', 'average')
        return String(row(await sortPreview(averages.id, 'average_amount')).sales_rep)
      },
    },
    {
      id: 'mcp-04',
      solve: async () => {
        const sales = await read('eval-sales')
        const direct = await filter(sales.id, [
          { field: 'status', operator: 'eq', value: 'completed' },
          { field: 'channel', operator: 'eq', value: 'Direct' },
        ])
        const totals = await aggregate(direct.id, 'customer_segment', 'quantity', 'sum')
        return String(row(await sortPreview(totals.id, 'sum_quantity')).sum_quantity)
      },
    },
    {
      id: 'mcp-05',
      solve: async () => {
        const sales = await read('eval-sales')
        const completed = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'completed' }])
        const totals = await aggregate(completed.id, 'region_id', 'amount', 'sum')
        const regions = await read('eval-regions')
        const joined = await mcp<ArtifactSummary>('table_join', {
          leftArtifactId: totals.id,
          rightArtifactId: regions.id,
          config: { leftKey: 'region_id', rightKey: 'region_id', joinType: 'inner' },
        })
        const gap = await mcp<ArtifactSummary>('table_derive', {
          artifactId: joined.id,
          config: { output: 'target_gap', operation: 'subtract', source: 'sum_amount', operandField: 'monthly_target', operandValue: null },
        })
        return String(row(await sortPreview(gap.id, 'target_gap')).region_name)
      },
    },
    {
      id: 'mcp-06',
      solve: async () => {
        const sales = await read('eval-sales')
        const refunded = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'refunded' }])
        const totals = await aggregate(refunded.id, 'category', 'amount', 'sum')
        return String(row(await sortPreview(totals.id, 'sum_amount')).category)
      },
    },
    {
      id: 'mcp-07',
      solve: async () => {
        const events = await parseEvents((await read('eval-events')).id)
        const mobile = await filter(events.id, [{ field: 'device', operator: 'eq', value: 'mobile' }])
        const totals = await aggregate(mobile.id, 'event_type', 'count', 'sum')
        return String(row(await sortPreview(totals.id, 'sum_count')).event_type)
      },
    },
    {
      id: 'mcp-08',
      solve: async () => {
        const events = await parseEvents((await read('eval-events')).id)
        const regions = await read('eval-regions')
        const totals = await mcp<ArtifactSummary>('table_join_aggregate', {
          leftArtifactId: events.id,
          rightArtifactId: regions.id,
          config: { leftKey: 'region_id', rightKey: 'region_id', groupBy: 'territory', metric: 'count', operation: 'sum' },
        })
        return String(row(await sortPreview(totals.id, 'sum_count')).territory)
      },
    },
    {
      id: 'mcp-09',
      solve: async () => {
        const sales = await read('eval-sales')
        const completed = await filter(sales.id, [{ field: 'status', operator: 'eq', value: 'completed' }])
        const salesTotals = await aggregate(completed.id, 'category', 'amount', 'sum')
        const events = await parseEvents((await read('eval-events')).id)
        const eventTotals = await aggregate(events.id, 'category', 'count', 'sum')
        const joined = await mcp<ArtifactSummary>('table_join', {
          leftArtifactId: salesTotals.id,
          rightArtifactId: eventTotals.id,
          config: { leftKey: 'category', rightKey: 'category', joinType: 'inner' },
        })
        const ratio = await mcp<ArtifactSummary>('table_derive', {
          artifactId: joined.id,
          config: { output: 'sales_per_event', operation: 'divide', source: 'sum_amount', operandField: 'sum_count', operandValue: null },
        })
        return String(row(await sortPreview(ratio.id, 'sales_per_event')).category)
      },
    },
    {
      id: 'mcp-10',
      solve: async () => {
        const sales = await read('eval-sales')
        const online = await filter(sales.id, [
          { field: 'status', operator: 'eq', value: 'completed' },
          { field: 'channel', operator: 'eq', value: 'Online' },
        ])
        const regions = await read('eval-regions')
        const averages = await mcp<ArtifactSummary>('table_join_aggregate', {
          leftArtifactId: online.id,
          rightArtifactId: regions.id,
          config: { leftKey: 'region_id', rightKey: 'region_id', groupBy: 'area_manager', metric: 'amount', operation: 'average' },
        })
        return String(row(await sortPreview(averages.id, 'average_amount')).area_manager)
      },
    },
  ]

  for (const evaluation of cases) {
    it(`${evaluation.id}: ${evaluation.id}`, async () => {
      const pair = expected.get(evaluation.id)
      expect(pair?.question.length).toBeGreaterThan(20)
      toolTrace = []
      const available = await mcp<{ sources: Array<{ id: string }> }>('data_source_list', {})
      expect(available.sources.map((source) => source.id).toSorted()).toEqual(['eval-events', 'eval-regions', 'eval-sales'])
      const actual = await evaluation.solve()
      expect(actual).toBe(pair?.answer)
      expect(toolTrace.length).toBeGreaterThanOrEqual(3)
      expect(toolTrace.every((tool) => [
        'data_source_list',
        'data_source_read',
        'documents_to_table',
        'table_filter_select',
        'table_aggregate',
        'table_join',
        'table_join_aggregate',
        'table_derive',
        'table_sort_limit',
        'artifact_preview',
      ].includes(tool))).toBe(true)
    })
  }
})
