import { validateWorkflowGraph, workflowSchema, type Workflow } from './workflow'
import { dataSourceDataModel, type DataModel, type DataSource } from './data-source'
import { validateQueryArguments } from './query-template'

export function validateWorkflow(input: unknown): { valid: boolean; errors: string[]; workflow?: Workflow } {
  const parsed = workflowSchema.safeParse(input)
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
  const errors = validateWorkflowGraph(parsed.data)
  return { valid: errors.length === 0, errors, workflow: parsed.data }
}

export function validateWorkflowDataModels(workflow: Workflow,
  sources: DataSource[]): string[] {
  const errors: string[] = []
  const sourceModels = new Map(sources.map((source) => [source.id, dataSourceDataModel(source)]))
  const outputs = new Map<string, DataModel | 'csv'>()
  for (const step of workflow.steps) {
    if (step.kind === 'query') {
      const source = sources.find((item) => item.id === step.config.source
        && (!step.config.template || item.version === step.config.template.sourceVersion))
      const model = source?.type === 'cloudwatch-logs' && step.config.template
        ? source.queryTemplates.find((template) => template.id === step.config.template?.id)?.outputDataModel
        : sourceModels.get(step.config.source)
      if (model) outputs.set(step.id, model)
      continue
    }
    if ('inputs' in step) {
      for (const [label, input] of [['左', step.inputs.left], ['右', step.inputs.right]] as const) {
        if (input && outputs.get(input) === 'documents') {
          errors.push(`「${step.title}」の${label}入力はJSONライク形式です。先に「表形式に変換」ノードが必要です。`)
        }
      }
      outputs.set(step.id, 'table')
      continue
    }
    const inputModel = step.input ? outputs.get(step.input) : undefined
    if (step.kind === 'parseDocuments') {
      if (inputModel && inputModel !== 'documents') errors.push(`「${step.title}」にはJSONライク形式の入力が必要です。`)
      outputs.set(step.id, 'table')
    } else if (step.kind === 'preview') {
      if (inputModel && inputModel !== 'csv') outputs.set(step.id, inputModel)
    } else if (step.kind === 'csv') {
      if (inputModel === 'documents') errors.push(`「${step.title}」の入力はJSONライク形式です。先に「表形式に変換」ノードが必要です。`)
      outputs.set(step.id, 'csv')
    } else {
      if (inputModel === 'documents') errors.push(`「${step.title}」の入力はJSONライク形式です。先に「表形式に変換」ノードが必要です。`)
      outputs.set(step.id, 'table')
    }
  }
  return errors
}

export function validateWorkflowQueries(workflow: Workflow, sources: DataSource[]): string[] {
  const errors: string[] = []
  for (const step of workflow.steps) {
    if (step.kind !== 'query') continue
    const source = sources.find((item) => item.id === step.config.source
      && (!step.config.template || item.version === step.config.template.sourceVersion))
    if (!source) {
      if (step.config.source !== 'unconfigured') errors.push(`「${step.title}」が参照するデータソースversionが見つかりません。`)
      continue
    }
    if (source.type !== 'cloudwatch-logs') {
      if (step.config.template) errors.push(`「${step.title}」のデータソースは検索パターンに対応していません。`)
      continue
    }
    if (source.queryMode === 'template-required' && !step.config.template) {
      errors.push(`「${step.title}」は検索パターンの選択が必要です。`)
      continue
    }
    if (!step.config.template) continue
    if (Object.keys(step.config.parameters).length > 0) errors.push(`「${step.title}」は検索パターンと任意parameterを併用できません。`)
    const template = source.queryTemplates.find((item) => item.id === step.config.template?.id)
    if (!template) {
      errors.push(`「${step.title}」が参照する検索パターンが見つかりません。`)
      continue
    }
    try { validateQueryArguments(template, step.config.template.arguments) }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  return errors
}
