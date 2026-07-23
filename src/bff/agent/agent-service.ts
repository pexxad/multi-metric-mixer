import { AppError } from '../../shared/errors'
import { validateWorkflowGraph, type WorkflowStep } from '../../shared/workflow'
import type { AgentModelInput, AgentModelProvider, AgentModelResponse } from './provider'

export class DisabledAgentModel implements AgentModelProvider {
  readonly metadata = { provider: 'disabled' as const, label: 'モデルAPI未設定', configured: false }

  async respond(_input: AgentModelInput): Promise<never> {
    throw new AppError('agent_provider_not_configured', 503,
      '分析エージェントはまだ設定されていません。BFFへOpenAI互換APIの接続先とモデルを設定してください。', undefined, true)
  }
}

export class AgentService {
  constructor(readonly model: AgentModelProvider) {}

  async respond(input: AgentModelInput): Promise<AgentModelResponse> {
    const response = await this.model.respond(input)
    if (response.state === 'proposal') validateAgentProposal(input, response)
    return response
  }
}

function validateAgentProposal(input: AgentModelInput, response: Extract<AgentModelResponse, { state: 'proposal' }>): void {
  const errors = validateWorkflowGraph(response.workflow)
  const sourceIds = new Set(input.dataSources.map((source) => source.id))
  const catalogFields = new Map(input.catalogs.map((catalog) => [catalog.sourceId,
    new Set(catalog.definition.fields.map((field) => field.path))]))
  const fieldsByStep = new Map<string, Set<string>>()

  for (const step of response.workflow.steps) {
    if (step.kind === 'query') {
      if (!sourceIds.has(step.config.source)) errors.push(`データソース「${step.config.source}」は利用できません。`)
      if (Object.keys(step.config.parameters).length > 0) {
        errors.push(`「${step.title}」にAgentが任意の取得parameterを追加しました。絞り込み・計算・集計は専用ノードで表現する必要があります。`)
      }
      const fields = catalogFields.get(step.config.source)
      if (!fields) errors.push(`データソース「${step.config.source}」のCatalogがありません。`)
      fieldsByStep.set(step.id, new Set(fields ?? []))
      continue
    }
    if ('inputs' in step) {
      const left = fieldsByStep.get(step.inputs.left ?? '') ?? new Set<string>()
      const right = fieldsByStep.get(step.inputs.right ?? '') ?? new Set<string>()
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
      continue
    }
    const fields = fieldsByStep.get(step.input ?? '') ?? new Set<string>()
    if (step.kind === 'filterSelect') {
      for (const field of step.config.columns) requireField(errors, step, '出力列', field, fields)
      for (const filter of step.config.filters) requireField(errors, step, '絞り込み列', filter.field, fields)
      fieldsByStep.set(step.id, step.config.columns.length ? new Set(step.config.columns) : new Set(fields))
    } else if (step.kind === 'derive') {
      requireField(errors, step, '元の列', step.config.source, fields)
      if (step.config.operandField) requireField(errors, step, '右辺の列', step.config.operandField, fields)
      fieldsByStep.set(step.id, new Set([...fields, step.config.output]))
    } else if (step.kind === 'aggregate') {
      requireField(errors, step, 'グループ列', step.config.groupBy, fields)
      requireField(errors, step, '指標列', step.config.metric, fields)
      fieldsByStep.set(step.id, new Set([step.config.groupBy, `${step.config.operation}_${step.config.metric}`]))
    } else if (step.kind === 'sortLimit') {
      requireField(errors, step, '並べ替え列', step.config.sortBy, fields)
      fieldsByStep.set(step.id, new Set(fields))
    } else {
      fieldsByStep.set(step.id, new Set(fields))
    }
  }
  for (const source of response.plan.dataSources) {
    if (!sourceIds.has(source.id)) errors.push(`計画のデータソース「${source.id}」は利用できません。`)
  }
  if (errors.length) throw new AppError('agent_invalid_workflow', 502,
    'モデルAPIの提案がData CatalogまたはWorkflow規則に一致しません。', [...new Set(errors)], true)
}

function requireField(errors: string[], step: WorkflowStep, label: string, field: string, available: Set<string>): void {
  if (!available.has(field)) errors.push(`「${step.title}」の${label}「${field}」は入力のData Catalogにありません。`)
}
