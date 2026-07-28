import { z } from 'zod'
import { queryArgumentsSchema } from './query-template'

const baseStepSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
})

export const queryStepSchema = baseStepSchema.extend({
  kind: z.literal('query'),
  config: z.object({
    source: z.string().min(1),
    parameters: z.record(z.string(), z.string()).default({}),
    template: z.object({
      id: z.string().min(1),
      sourceVersion: z.number().int().positive(),
      arguments: queryArgumentsSchema,
    }).strict().nullable().optional(),
  }),
})

const parseColumnSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
    .describe('Output column name, for example region_id or device.'),
  path: z.string().min(1).max(512).regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/)
    .describe('JSON path relative to each selected record. Use $.field or $.nested.field; arrays and wildcards are not allowed here.'),
  dataType: z.enum(['string', 'number', 'boolean', 'datetime'])
    .describe('Scalar output type. Values are converted to this type; objects and arrays are not scalar values.'),
}).strict()

export const parseDocumentsStepSchema = baseStepSchema.extend({
  kind: z.literal('parseDocuments'),
  input: z.string().min(1).nullable(),
  config: z.object({
    recordPath: z.string().min(1).max(512).regex(/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*(?:\[\])?$/)
      .describe('Select records from each document. Use $ when each document is already one record. Use $.items[] only to explode a nested array. Do not use $[], [*], or [].'),
    columns: z.array(parseColumnSchema).min(1).max(100)
      .describe('Explicit scalar columns to extract from each selected record. Column paths are relative to recordPath.'),
    onMissing: z.enum(['null', 'skip', 'error']).default('null')
      .describe('For a missing column path: emit null, skip the whole record, or return an error.'),
    onTypeMismatch: z.enum(['null', 'skip', 'error']).default('error')
      .describe('For a value that cannot be converted: emit null, skip the whole record, or return an error.'),
  }).strict(),
})

export const aggregateStepSchema = baseStepSchema.extend({
  kind: z.literal('aggregate'),
  input: z.string().min(1).nullable(),
  config: z.object({
    groupBy: z.string().min(1).nullable().describe('Column used to form groups, or null for one aggregate over all rows.'),
    metric: z.string().min(1).nullable().describe('Numeric column to aggregate. Use null only when operation is count.'),
    operation: z.enum(['sum', 'average', 'count', 'min', 'max'])
      .describe('Aggregation operation. Output column is operation_metric, such as sum_amount or average_amount.'),
  }).superRefine((config, context) => {
    if (config.operation !== 'count' && !config.metric) {
      context.addIssue({ code: 'custom', path: ['metric'], message: '件数以外の集計には数値列が必要です。' })
    }
  }),
})

const filterSchema = z.object({
  field: z.string().min(1).describe('Existing table column to test.'),
  operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'isNotNull'])
    .describe('Comparison applied to the field. Date-time strings can be compared with gte/lte in ISO 8601 form.'),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(null)
    .describe('Comparison value. Use null for isNull and isNotNull.'),
}).strict()

export const filterSelectStepSchema = baseStepSchema.extend({
  kind: z.literal('filterSelect'),
  input: z.string().min(1).nullable(),
  config: z.object({
    columns: z.array(z.string().min(1)).max(100).default([])
      .describe('Columns to retain. Use an empty array to retain all columns.'),
    filters: z.array(filterSchema).max(20).default([])
      .describe('All filter conditions must match. Use an empty array when only selecting columns.'),
  }).strict(),
})

export const deriveStepSchema = baseStepSchema.extend({
  kind: z.literal('derive'),
  input: z.string().min(1).nullable(),
  config: z.object({
    output: z.string().min(1).describe('Name of the new output column.'),
    operation: z.enum(['toNumber', 'toString', 'year', 'month', 'add', 'subtract', 'multiply', 'divide'])
      .describe('Conversion, date extraction, or arithmetic operation applied to source.'),
    source: z.string().min(1).describe('Existing left-hand source column.'),
    operandField: z.string().min(1).nullable().default(null)
      .describe('Existing right-hand column for add/subtract/multiply/divide. Set this and operandValue to null for conversions.'),
    operandValue: z.number().nullable().default(null)
      .describe('Constant right-hand number for arithmetic. Use either operandField or operandValue, not both.'),
  }).strict(),
})

export const joinStepSchema = baseStepSchema.extend({
  kind: z.literal('join'),
  inputs: z.object({ left: z.string().min(1).nullable(), right: z.string().min(1).nullable() }),
  config: z.object({
    leftKey: z.string().min(1).describe('Join key column in the left artifact.'),
    rightKey: z.string().min(1).describe('Join key column in the right artifact.'),
    joinType: z.enum(['inner', 'left']).describe('inner keeps matches; left also keeps unmatched left rows.'),
  }).strict(),
})

export const sortLimitStepSchema = baseStepSchema.extend({
  kind: z.literal('sortLimit'),
  input: z.string().min(1).nullable(),
  config: z.object({
    sortBy: z.string().min(1).describe('Existing column used for stable sorting.'),
    direction: z.enum(['asc', 'desc']).describe('Use desc for the largest values first and asc for the smallest values first.'),
    limit: z.number().int().min(1).max(5_000).describe('Maximum number of rows returned after sorting.'),
  }).strict(),
})

export const joinAggregateStepSchema = baseStepSchema.extend({
  kind: z.literal('joinAggregate'),
  inputs: z.object({ left: z.string().min(1).nullable(), right: z.string().min(1).nullable() }),
  config: z.object({
    leftKey: z.string().min(1).describe('Join key column in the left artifact.'),
    rightKey: z.string().min(1).describe('Join key column in the right artifact.'),
    groupBy: z.string().min(1)
      .describe('Grouping column from either joined artifact, for example a descriptive field from the right master table.'),
    metric: z.string().min(1).describe('Numeric metric column from the left artifact.'),
    operation: z.enum(['sum', 'average'])
      .describe('Aggregation after the join. Output column is sum_metric or average_metric.'),
  }),
})

export const previewStepSchema = baseStepSchema.extend({
  kind: z.literal('preview'),
  input: z.string().min(1).nullable(),
  config: z.object({ limit: z.number().int().min(1).max(100) }),
})

export const csvStepSchema = baseStepSchema.extend({
  kind: z.literal('csv'),
  input: z.string().min(1).nullable(),
  config: z.object({
    fileName: z.string().min(1).regex(/^[a-zA-Z0-9_-]+\.csv$/),
    mode: z.enum(['spreadsheet', 'machine']).default('spreadsheet'),
  }),
})

export const workflowStepSchema = z.discriminatedUnion('kind', [
  queryStepSchema,
  parseDocumentsStepSchema,
  filterSelectStepSchema,
  deriveStepSchema,
  joinStepSchema,
  aggregateStepSchema,
  joinAggregateStepSchema,
  sortLimitStepSchema,
  previewStepSchema,
  csvStepSchema,
])

export const workflowSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  steps: z.array(workflowStepSchema).min(1).max(20),
})

export type QueryStep = z.infer<typeof queryStepSchema>
export type ParseDocumentsStep = z.infer<typeof parseDocumentsStepSchema>
export type FilterSelectStep = z.infer<typeof filterSelectStepSchema>
export type DeriveStep = z.infer<typeof deriveStepSchema>
export type JoinStep = z.infer<typeof joinStepSchema>
export type AggregateStep = z.infer<typeof aggregateStepSchema>
export type JoinAggregateStep = z.infer<typeof joinAggregateStepSchema>
export type SortLimitStep = z.infer<typeof sortLimitStepSchema>
export type PreviewStep = z.infer<typeof previewStepSchema>
export type CsvStep = z.infer<typeof csvStepSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type Workflow = z.infer<typeof workflowSchema>

export function aggregateOutputColumn(config: AggregateStep['config']): string {
  return config.operation === 'count' && !config.metric ? 'count' : `${config.operation}_${config.metric}`
}

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type TableRow = Record<string, JsonValue>

export type ArtifactSummary = {
  id: string
  type: 'documents' | 'table' | 'csv'
  name: string
  rowCount: number
  columns: string[]
  preview?: JsonValue[]
  provenance: string[]
  trustLevel: 'untrusted'
  classification: 'internal' | 'confidential' | 'restricted'
  checksum: string
  createdAt: string
}

type StepRun = {
  stepId: string
  status: 'completed' | 'failed'
  artifact: ArtifactSummary
  durationMs: number
}

export type WorkflowRun = {
  id: string
  workflowId: string
  status: 'completed' | 'failed'
  startedAt: string
  durationMs: number
  steps: StepRun[]
  finalArtifact: ArtifactSummary
}

export const sampleWorkflow: Workflow = {
  version: 1,
  id: 'wf-rest-json-preview',
  name: 'REST JSON プレビュー',
  description: '登録したREST APIからJSONを取得し、構造を確認してCSVへ出力します。',
  steps: [
    {
      id: 'fetch-json',
      kind: 'query',
      title: 'REST APIから取得',
      config: { source: 'unconfigured', parameters: {}, template: null },
    },
    {
      id: 'parse-json',
      kind: 'parseDocuments',
      title: 'JSONを表形式に変換',
      input: 'fetch-json',
      config: {
        recordPath: '$[]',
        columns: [{ name: 'value', path: '$.value', dataType: 'string' }],
        onMissing: 'null',
        onTypeMismatch: 'error',
      },
    },
    {
      id: 'preview',
      kind: 'preview',
      title: 'JSONをプレビュー',
      input: 'parse-json',
      config: { limit: 10 },
    },
    {
      id: 'csv',
      kind: 'csv',
      title: 'CSVを書き出す',
      input: 'parse-json',
      config: { fileName: 'rest-response.csv', mode: 'spreadsheet' },
    },
  ],
}

export function validateWorkflowGraph(workflow: Workflow): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const step of workflow.steps) {
    if (ids.has(step.id)) errors.push(`ステップID「${step.id}」が重複しています。`)
    if (step.kind === 'query' && step.config.source === 'unconfigured') {
      errors.push(`「${step.title}」のデータソースが設定されていません。`)
    }
    if ('input' in step && (!step.input || !ids.has(step.input))) {
      errors.push(step.input
        ? `「${step.title}」の入力「${step.input}」が先行ステップにありません。`
        : `「${step.title}」の入力が接続されていません。`)
    }
    if ('inputs' in step) {
      for (const [side, input] of [['左', step.inputs.left], ['右', step.inputs.right]] as const) {
        if (!input) errors.push(`「${step.title}」の${side}入力が接続されていません。`)
        else if (!ids.has(input)) errors.push(`「${step.title}」の入力「${input}」が先行ステップにありません。`)
      }
      if (step.inputs.left && step.inputs.left === step.inputs.right) errors.push(`「${step.title}」の左右入力には異なるステップが必要です。`)
    }
    ids.add(step.id)
  }
  return errors
}

export function deleteWorkflowSteps(workflow: Workflow, stepIds: string[]): Workflow {
  const deleted = new Set(stepIds)
  return {
    ...workflow,
    steps: workflow.steps
      .filter((step) => !deleted.has(step.id))
      .map((step) => {
        if ('inputs' in step) return { ...step, inputs: {
          left: step.inputs.left && deleted.has(step.inputs.left) ? null : step.inputs.left,
          right: step.inputs.right && deleted.has(step.inputs.right) ? null : step.inputs.right,
        } }
        return 'input' in step && step.input && deleted.has(step.input) ? { ...step, input: null } : step
      }),
  }
}
