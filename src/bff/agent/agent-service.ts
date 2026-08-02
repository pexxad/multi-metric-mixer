import { AppError } from '../../shared/errors'
import { aggregateOutputColumn, validateWorkflowGraph, type WorkflowStep } from '../../shared/workflow'
import type { AgentModelInput, AgentModelProvider, AgentModelResponse } from './provider'
import type { AgentGenerationActivity } from '../../shared/api'
import { validateQueryArguments } from '../../shared/query-template'

export class DisabledAgentModel implements AgentModelProvider {
  readonly metadata = { provider: 'disabled' as const }

  async respond(_input: AgentModelInput): Promise<never> {
    throw new AppError('agent_provider_not_configured', 503,
      '分析エージェントを現在利用できません。時間をおいて再度お試しいただくか、管理者へ連絡してください。', undefined, true)
  }
}

export class AgentService {
  constructor(readonly model: AgentModelProvider) {}

  async respond(input: AgentModelInput,
    onGeneration?: (activity: AgentGenerationActivity) => void | Promise<void>): Promise<AgentModelResponse> {
    let attemptInput = input
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await this.model.respond(attemptInput, onGeneration)
        if (response.state === 'proposal') validateAgentProposal(attemptInput, response)
        return response
      } catch (error) {
        if (attempt > 0 || !(error instanceof AppError)
          || !['agent_invalid_response', 'agent_invalid_workflow'].includes(error.code)) throw error
        attemptInput = {
          ...input,
          currentTurn: {
            events: input.currentTurn?.events ?? [],
            proposalValidationErrors: validationFeedback(error),
          },
        }
      }
    }
    throw new AppError('agent_invalid_response', 502,
      '分析エージェントの応答を処理できませんでした。再度お試しください。', undefined, true)
  }
}

function validationFeedback(error: AppError): string[] {
  const details = Array.isArray(error.details) ? error.details : []
  const messages = details.flatMap((detail) => {
    if (typeof detail === 'string') return [detail]
    if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') {
      return [detail.message]
    }
    return []
  })
  return (messages.length > 0 ? messages : [error.message]).slice(0, 20).map((message) => message.slice(0, 500))
}

function validateAgentProposal(input: AgentModelInput, response: Extract<AgentModelResponse, { state: 'proposal' }>): void {
  const errors = validateWorkflowGraph(response.workflow)
  const sourceIds = new Set(input.dataSources.map((source) => source.id))
  const sourceModels = new Map(input.dataSources.map((source) => [source.id, source.dataModel]))
  const sourceDefinitions = new Map(input.dataSources.map((source) => [source.id, source]))
  const catalogFields = new Map(input.catalogs.map((catalog) => [catalog.sourceId,
    new Set(catalog.definition.fields.map((field) => field.path))]))
  const fieldsByStep = new Map<string, Set<string>>()
  const modelsByStep = new Map<string, 'table' | 'documents'>()

  for (const step of response.workflow.steps) {
    if (step.kind === 'query') {
      if (!sourceIds.has(step.config.source)) errors.push(`データソース「${step.config.source}」は利用できません。`)
      if (Object.keys(step.config.parameters).length > 0) {
        errors.push(`「${step.title}」にAgentが任意の取得parameterを追加しました。絞り込み・計算・集計は専用ノードで表現する必要があります。`)
      }
      const source = sourceDefinitions.get(step.config.source)
      if (source?.queryMode === 'template-required' && !step.config.template) {
        errors.push(`「${step.title}」は登録済み検索パターンの選択が必要です。`)
      }
      if (step.config.template) {
        const template = source?.queryTemplates?.find((item) => item.id === step.config.template?.id)
        if (!template || step.config.template.sourceVersion !== source?.version) {
          errors.push(`「${step.title}」の検索パターンまたはデータソースversionが利用できません。`)
        } else {
          try {
            validateQueryArguments(template, step.config.template.arguments)
          } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
        }
      }
      const selectedTemplate = step.config.template
        ? source?.queryTemplates?.find((item) => item.id === step.config.template?.id) : undefined
      const fields = catalogFields.get(step.config.source)
      if (!fields && !selectedTemplate?.outputFields.length) errors.push(`データソース「${step.config.source}」のCatalogまたは検索パターン出力項目がありません。`)
      fieldsByStep.set(step.id, new Set(selectedTemplate?.outputFields.length ? selectedTemplate.outputFields : fields ?? []))
      const dataModel = selectedTemplate?.outputDataModel ?? sourceModels.get(step.config.source)
      if (dataModel) modelsByStep.set(step.id, dataModel)
      continue
    }
    if ('inputs' in step) {
      const left = fieldsByStep.get(step.inputs.left ?? '') ?? new Set<string>()
      const right = fieldsByStep.get(step.inputs.right ?? '') ?? new Set<string>()
      requireTableInput(errors, step, '左入力', modelsByStep.get(step.inputs.left ?? ''))
      requireTableInput(errors, step, '右入力', modelsByStep.get(step.inputs.right ?? ''))
      requireField(errors, step, '左の結合列', step.config.leftKey, left)
      requireField(errors, step, '右の結合列', step.config.rightKey, right)
      if (step.kind === 'joinAggregate') {
        requireField(errors, step, '数値列', step.config.metric, left)
        requireField(errors, step, 'グループ列', step.config.groupBy, right)
        fieldsByStep.set(step.id, new Set([step.config.groupBy, `${step.config.operation}_${step.config.metric}`]))
      } else {
        const output = new Set(left)
        for (const field of right) output.add(output.has(field) ? `right.${field}` : field)
        fieldsByStep.set(step.id, output)
      }
      modelsByStep.set(step.id, 'table')
      continue
    }
    const fields = fieldsByStep.get(step.input ?? '') ?? new Set<string>()
    const inputModel = modelsByStep.get(step.input ?? '')
    if (step.kind === 'parseDocuments') {
      if (inputModel !== 'documents') errors.push(`「${step.title}」にはJSONライク形式の入力が必要です。`)
      fieldsByStep.set(step.id, new Set(step.config.columns.map((column) => column.name)))
      modelsByStep.set(step.id, 'table')
    } else if (step.kind === 'filterSelect') {
      requireTableInput(errors, step, '入力', inputModel)
      for (const field of step.config.columns) requireField(errors, step, '出力列', field, fields)
      for (const filter of step.config.filters) requireField(errors, step, '絞り込み列', filter.field, fields)
      fieldsByStep.set(step.id, step.config.columns.length ? new Set(step.config.columns) : new Set(fields))
      modelsByStep.set(step.id, 'table')
    } else if (step.kind === 'derive') {
      requireTableInput(errors, step, '入力', inputModel)
      requireField(errors, step, '元の列', step.config.source, fields)
      if (step.config.operandField) requireField(errors, step, '右辺の列', step.config.operandField, fields)
      fieldsByStep.set(step.id, new Set([...fields, step.config.output]))
      modelsByStep.set(step.id, 'table')
    } else if (step.kind === 'aggregate') {
      requireTableInput(errors, step, '入力', inputModel)
      if (step.config.groupBy) requireField(errors, step, 'グループ列', step.config.groupBy, fields)
      if (step.config.metric) requireField(errors, step, '指標列', step.config.metric, fields)
      fieldsByStep.set(step.id, new Set([
        ...(step.config.groupBy ? [step.config.groupBy] : []),
        aggregateOutputColumn(step.config),
      ]))
      modelsByStep.set(step.id, 'table')
    } else if (step.kind === 'sortLimit') {
      requireTableInput(errors, step, '入力', inputModel)
      requireField(errors, step, '並べ替え列', step.config.sortBy, fields)
      fieldsByStep.set(step.id, new Set(fields))
      modelsByStep.set(step.id, 'table')
    } else {
      fieldsByStep.set(step.id, new Set(fields))
      if (inputModel) modelsByStep.set(step.id, inputModel)
    }
  }
  for (const source of response.plan.dataSources) {
    if (!sourceIds.has(source.id)) errors.push(`計画のデータソース「${source.id}」は利用できません。`)
  }
  if (errors.length) throw new AppError('agent_invalid_workflow', 502,
    '分析エージェントの提案をWorkflowとして処理できませんでした。再度お試しください。', [...new Set(errors)], true)
}

function requireTableInput(errors: string[], step: WorkflowStep, label: string, model: 'table' | 'documents' | undefined): void {
  if (model === 'documents') errors.push(`「${step.title}」の${label}はJSONライク形式です。先にparseDocumentsが必要です。`)
}

function requireField(errors: string[], step: WorkflowStep, label: string, field: string, available: Set<string>): void {
  if (!available.has(field)) errors.push(`「${step.title}」の${label}「${field}」は入力のData Catalogにありません。`)
}
