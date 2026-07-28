import { describe, expect, it } from 'vitest'
import { queryTemplateSchema, renderCloudWatchQuery, validateQueryArguments } from './query-template'

const template = queryTemplateSchema.parse({
  id: 'errors-by-service',
  name: 'サービス別エラー',
  description: '',
  outputDataModel: 'documents',
  variables: [
    { id: 'startTime', label: '開始日時', input: 'datetime', type: 'datetime', required: true },
    { id: 'endTime', label: '終了日時', input: 'datetime', type: 'datetime', required: true },
    { id: 'service', label: 'サービス', input: 'select', type: 'string', required: true,
      options: [{ value: 'payment', label: '決済' }, { value: 'order', label: '注文' }] },
  ],
  execution: { kind: 'cloudwatch-logs-insights', query: 'fields @message | filter service = {{service}}',
    startTimeVariable: 'startTime', endTimeVariable: 'endTime' },
})

describe('parameterized query templates', () => {
  it('validates variables and renders values without raw string interpolation', () => {
    const rendered = renderCloudWatchQuery(template, {
      startTime: '2026-07-25T00:00:00+09:00', endTime: '2026-07-26T00:00:00+09:00', service: 'payment',
    })
    expect(rendered.query).toContain('service = "payment"')
    expect(rendered.endTime - rendered.startTime).toBe(86_400)
  })

  it('rejects unknown arguments and values outside registered select options', () => {
    expect(() => validateQueryArguments(template, {
      startTime: '2026-07-25T00:00:00Z', endTime: '2026-07-26T00:00:00Z', service: 'unknown',
    })).toThrow('選択肢')
    expect(() => validateQueryArguments(template, {
      startTime: '2026-07-25T00:00:00Z', endTime: '2026-07-26T00:00:00Z', service: 'payment', sql: 'drop',
    })).toThrow('検索パターンにない')
  })
})
