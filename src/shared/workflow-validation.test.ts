import { describe, expect, it } from 'vitest'
import { validateWorkflowDataModels, validateWorkflowQueries } from './workflow-validation'
import type { Workflow } from './workflow'

const restSource = {
  id: 'orders-api',
  name: 'Orders',
  type: 'rest-json' as const,
  baseUrl: 'https://example.com',
  path: '/orders',
  method: 'GET' as const,
  version: 1,
  accessMode: 'read-only' as const,
  status: 'active' as const,
}

describe('Workflow data model validation', () => {
  it('requires an explicit parser before table aggregation even when REST JSON could be flat', () => {
    const workflow: Workflow = {
      version: 1, id: 'wf-invalid-documents', name: 'Invalid', description: '', steps: [
        { id: 'read', kind: 'query', title: 'RESTから取得', config: { source: restSource.id, parameters: {} } },
        { id: 'sum', kind: 'aggregate', title: '合計', input: 'read',
          config: { groupBy: 'region', metric: 'amount', operation: 'sum' } },
      ],
    }
    expect(validateWorkflowDataModels(workflow, [restSource])).toEqual([
      '「合計」の入力はJSONライク形式です。先に「表形式に変換」ノードが必要です。',
    ])
  })

  it('accepts aggregation after an explicit Documents-to-Table parser', () => {
    const workflow: Workflow = {
      version: 1, id: 'wf-parsed-documents', name: 'Parsed', description: '', steps: [
        { id: 'read', kind: 'query', title: 'RESTから取得', config: { source: restSource.id, parameters: {} } },
        { id: 'parse', kind: 'parseDocuments', title: '表形式に変換', input: 'read', config: {
          recordPath: '$[]',
          columns: [
            { name: 'region', path: '$.region', dataType: 'string' },
            { name: 'amount', path: '$.amount', dataType: 'number' },
          ],
          onMissing: 'null', onTypeMismatch: 'error',
        } },
        { id: 'sum', kind: 'aggregate', title: '合計', input: 'parse',
          config: { groupBy: 'region', metric: 'amount', operation: 'sum' } },
      ],
    }
    expect(validateWorkflowDataModels(workflow, [restSource])).toEqual([])
  })
})

describe('Workflow query-template validation', () => {
  const source = {
    id: 'logs', name: 'Logs', type: 'cloudwatch-logs' as const, region: 'ap-northeast-1', logGroupName: '/app',
    maxResults: 1000, maxRangeSeconds: 86400, queryMode: 'template-required' as const, version: 2,
    accessMode: 'read-only' as const, status: 'active' as const, queryTemplates: [{
      id: 'errors', name: 'Errors', description: '', outputDataModel: 'documents' as const,
      outputFields: ['@timestamp', '@message'],
      variables: [
        { id: 'startTime', label: '開始', description: '', required: true, input: 'datetime' as const, type: 'datetime' as const },
        { id: 'endTime', label: '終了', description: '', required: true, input: 'datetime' as const, type: 'datetime' as const },
      ], execution: { kind: 'cloudwatch-logs-insights' as const, query: 'fields @message',
        startTimeVariable: 'startTime', endTimeVariable: 'endTime' },
    }],
  }

  it('requires a registered pattern, pinned source version and valid arguments', () => {
    const workflow = {
      version: 1 as const, id: 'wf', name: 'Logs', description: '', steps: [{
        id: 'logs', kind: 'query' as const, title: 'Logs', config: { source: 'logs', parameters: {},
          template: { id: 'errors', sourceVersion: 2, arguments: { startTime: 'invalid' } } },
      }],
    }
    expect(validateWorkflowQueries(workflow, [source]).join(' ')).toContain('日時')
    expect(validateWorkflowQueries({ ...workflow, steps: [{ ...workflow.steps[0]!,
      config: { source: 'logs', parameters: {}, template: undefined } }] }, [source])).toEqual(['「Logs」は検索パターンの選択が必要です。'])
  })
})
