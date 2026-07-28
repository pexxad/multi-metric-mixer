import { z } from 'zod'
import { AppError } from './errors'

const variableBase = {
  id: z.string().min(1).max(64).regex(/^[a-z][A-Za-z0-9_]*$/),
  label: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  required: z.boolean().default(true),
}

export const queryVariableSchema = z.discriminatedUnion('input', [
  z.object({ ...variableBase, input: z.literal('text'), type: z.literal('string'),
    maxLength: z.number().int().min(1).max(1_000).default(100), defaultValue: z.string().optional() }).strict(),
  z.object({ ...variableBase, input: z.literal('select'), type: z.literal('string'),
    options: z.array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1).max(100) }).strict()).min(1).max(200),
    defaultValue: z.string().optional() }).strict(),
  z.object({ ...variableBase, input: z.literal('number'), type: z.literal('integer'),
    minimum: z.number().int().optional(), maximum: z.number().int().optional(), defaultValue: z.number().int().optional() }).strict(),
  z.object({ ...variableBase, input: z.literal('datetime'), type: z.literal('datetime'),
    defaultValue: z.string().datetime({ offset: true }).optional() }).strict(),
])
export type QueryVariable = z.infer<typeof queryVariableSchema>

const templateSchemaBase = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(100),
  description: z.string().max(1_000).default(''),
  outputDataModel: z.enum(['documents', 'table']),
  outputFields: z.array(z.string().min(1).max(256)).max(100).default([]),
  variables: z.array(queryVariableSchema).min(1).max(30),
  execution: z.object({
    kind: z.literal('cloudwatch-logs-insights'),
    query: z.string().min(1).max(4_096),
    startTimeVariable: z.string().min(1),
    endTimeVariable: z.string().min(1),
  }).strict(),
}).strict()

export const queryTemplateSchema = templateSchemaBase.superRefine((template, context) => {
  const byId = new Map(template.variables.map((variable) => [variable.id, variable]))
  if (byId.size !== template.variables.length) context.addIssue({ code: 'custom', path: ['variables'], message: '変数IDが重複しています。' })
  for (const [key, id] of [['startTimeVariable', template.execution.startTimeVariable],
    ['endTimeVariable', template.execution.endTimeVariable]] as const) {
    if (byId.get(id)?.type !== 'datetime') context.addIssue({ code: 'custom', path: ['execution', key], message: '日時型の変数を指定してください。' })
  }
  const placeholders = [...template.execution.query.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map((match) => match[1]!)
  for (const placeholder of placeholders) {
    if (!byId.has(placeholder)) context.addIssue({ code: 'custom', path: ['execution', 'query'], message: `未定義の変数「${placeholder}」があります。` })
  }
})
export type QueryTemplate = z.infer<typeof queryTemplateSchema>

export const queryArgumentsSchema = z.record(z.string(), z.union([z.string(), z.number()])).default({})
export type QueryArguments = z.infer<typeof queryArgumentsSchema>

export function validateQueryArguments(template: Pick<QueryTemplate, 'variables'>, input: QueryArguments): QueryArguments {
  const unknown = Object.keys(input).filter((key) => !template.variables.some((variable) => variable.id === key))
  if (unknown.length) throw new AppError('query_argument_unknown', 400, `検索パターンにない変数「${unknown[0]}」は指定できません。`)
  const result: QueryArguments = {}
  for (const variable of template.variables) {
    const raw = input[variable.id] ?? variable.defaultValue
    if (raw === undefined || raw === '') {
      if (variable.required) throw new AppError('query_argument_required', 400, `「${variable.label}」を入力してください。`)
      continue
    }
    if (variable.type === 'integer') {
      const value = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isInteger(value) || (variable.minimum !== undefined && value < variable.minimum)
        || (variable.maximum !== undefined && value > variable.maximum)) {
        throw new AppError('query_argument_invalid', 400, `「${variable.label}」の値が許可範囲外です。`)
      }
      result[variable.id] = value
    } else if (variable.type === 'datetime') {
      const value = String(raw)
      if (!Number.isFinite(Date.parse(value))) throw new AppError('query_argument_invalid', 400, `「${variable.label}」には日時を指定してください。`)
      result[variable.id] = value
    } else {
      const value = String(raw)
      if (variable.input === 'select' && !variable.options.some((option) => option.value === value)) {
        throw new AppError('query_argument_invalid', 400, `「${variable.label}」は選択肢から指定してください。`)
      }
      if (variable.input === 'text' && value.length > variable.maxLength) {
        throw new AppError('query_argument_invalid', 400, `「${variable.label}」が長すぎます。`)
      }
      result[variable.id] = value
    }
  }
  return result
}

export function renderCloudWatchQuery(template: QueryTemplate, arguments_: QueryArguments): {
  query: string
  startTime: number
  endTime: number
} {
  const values = validateQueryArguments(template, arguments_)
  const render = (id: string) => {
    const variable = template.variables.find((item) => item.id === id)!
    const value = values[id]
    if (value === undefined) return 'null'
    return variable.type === 'integer' ? String(value) : JSON.stringify(String(value))
  }
  const query = template.execution.query.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, id: string) => render(id))
  return {
    query,
    startTime: Math.floor(Date.parse(String(values[template.execution.startTimeVariable])) / 1_000),
    endTime: Math.floor(Date.parse(String(values[template.execution.endTimeVariable])) / 1_000),
  }
}
