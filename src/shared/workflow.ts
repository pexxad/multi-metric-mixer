import { z } from 'zod'

const baseStepSchema = z.object({
  id: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
})

export const queryStepSchema = baseStepSchema.extend({
  kind: z.literal('query'),
  config: z.object({
    source: z.string().min(1),
    parameters: z.record(z.string(), z.string()).default({}),
  }),
})

export const aggregateStepSchema = baseStepSchema.extend({
  kind: z.literal('aggregate'),
  input: z.string().min(1).nullable(),
  config: z.object({
    groupBy: z.string().min(1),
    metric: z.string().min(1),
    operation: z.enum(['sum', 'average', 'count', 'min', 'max']),
  }),
})

const filterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'isNull', 'isNotNull']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(null),
}).strict()

export const filterSelectStepSchema = baseStepSchema.extend({
  kind: z.literal('filterSelect'),
  input: z.string().min(1).nullable(),
  config: z.object({
    columns: z.array(z.string().min(1)).max(100).default([]),
    filters: z.array(filterSchema).max(20).default([]),
  }).strict(),
})

export const deriveStepSchema = baseStepSchema.extend({
  kind: z.literal('derive'),
  input: z.string().min(1).nullable(),
  config: z.object({
    output: z.string().min(1),
    operation: z.enum(['toNumber', 'toString', 'year', 'month', 'add', 'subtract', 'multiply', 'divide']),
    source: z.string().min(1),
    operandField: z.string().min(1).nullable().default(null),
    operandValue: z.number().nullable().default(null),
  }).strict(),
})

export const joinStepSchema = baseStepSchema.extend({
  kind: z.literal('join'),
  inputs: z.object({ left: z.string().min(1).nullable(), right: z.string().min(1).nullable() }),
  config: z.object({
    leftKey: z.string().min(1),
    rightKey: z.string().min(1),
    joinType: z.enum(['inner', 'left']),
  }).strict(),
})

export const sortLimitStepSchema = baseStepSchema.extend({
  kind: z.literal('sortLimit'),
  input: z.string().min(1).nullable(),
  config: z.object({
    sortBy: z.string().min(1),
    direction: z.enum(['asc', 'desc']),
    limit: z.number().int().min(1).max(5_000),
  }).strict(),
})

export const joinAggregateStepSchema = baseStepSchema.extend({
  kind: z.literal('joinAggregate'),
  inputs: z.object({ left: z.string().min(1).nullable(), right: z.string().min(1).nullable() }),
  config: z.object({
    leftKey: z.string().min(1),
    rightKey: z.string().min(1),
    groupBy: z.string().min(1),
    metric: z.string().min(1),
    operation: z.enum(['sum', 'average']),
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

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type TableRow = Record<string, JsonValue>

export type ArtifactSummary = {
  id: string
  type: 'table' | 'csv'
  name: string
  rowCount: number
  columns: string[]
  preview?: TableRow[]
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
      config: { source: 'unconfigured', parameters: {} },
    },
    {
      id: 'preview',
      kind: 'preview',
      title: 'JSONをプレビュー',
      input: 'fetch-json',
      config: { limit: 10 },
    },
    {
      id: 'csv',
      kind: 'csv',
      title: 'CSVを書き出す',
      input: 'fetch-json',
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
