import type { Connection, Edge } from '@xyflow/react'
import type { CatalogField, CatalogVersion } from '../shared/catalog'
import type { DataModel } from '../shared/data-source'
import { aggregateOutputColumn, type Workflow, type WorkflowStep } from '../shared/workflow'
import type { DataSource } from './api'

export type WorkflowHistory = { past: Workflow[]; present: Workflow; future: Workflow[] }
export type WorkflowHistoryAction =
  | { type: 'edit'; update: Workflow | ((current: Workflow) => Workflow) }
  | { type: 'reset'; workflow: Workflow }
  | { type: 'undo' }
  | { type: 'redo' }

export function sourceIdsForStep(workflow: Workflow, stepId: string | null, visited = new Set<string>()): string[] {
  if (!stepId || visited.has(stepId)) return []
  visited.add(stepId)
  const step = workflow.steps.find((item) => item.id === stepId)
  if (!step) return []
  if (step.kind === 'query') return step.config.source === 'unconfigured' ? [] : [step.config.source]
  if ('input' in step) return sourceIdsForStep(workflow, step.input, visited)
  return [...new Set([
    ...sourceIdsForStep(workflow, step.inputs.left, new Set(visited)),
    ...sourceIdsForStep(workflow, step.inputs.right, new Set(visited)),
  ])]
}

function derivedField(path: string, type: CatalogField['dataTypes'][number]): CatalogField {
  return {
    path,
    dataTypes: [type],
    nullable: false,
    presence: 1,
    repeated: false,
    businessName: '',
    description: '',
    unit: '',
    timezone: '',
  }
}

export function fieldsForStep(
  workflow: Workflow,
  catalogs: CatalogVersion[],
  dataSources: DataSource[],
  stepId: string | null,
  visited = new Set<string>(),
): CatalogField[] {
  if (!stepId || visited.has(stepId)) return []
  visited.add(stepId)
  const step = workflow.steps.find((item) => item.id === stepId)
  if (!step) return []
  if (step.kind === 'query') {
    const source = dataSources.find((item) => item.id === step.config.source)
    const outputFields = source?.type === 'cloudwatch-logs' && step.config.template
      ? source.queryTemplates.find((template) => template.id === step.config.template?.id)?.outputFields
      : undefined
    return outputFields?.length
      ? outputFields.map((field) => derivedField(field, 'string'))
      : catalogs.find((catalog) => catalog.sourceId === step.config.source)?.definition.fields ?? []
  }
  if ('inputs' in step) {
    const left = fieldsForStep(workflow, catalogs, dataSources, step.inputs.left, new Set(visited))
    const right = fieldsForStep(workflow, catalogs, dataSources, step.inputs.right, new Set(visited))
    if (step.kind === 'joinAggregate') {
      const group = right.find((field) => field.path === step.config.groupBy)
      return [...(group ? [group] : []), derivedField(`${step.config.operation}_${step.config.metric}`, 'number')]
    }
    const output = new Map(left.map((field) => [field.path, field]))
    for (const field of right) {
      const path = output.has(field.path) ? `right.${field.path}` : field.path
      output.set(path, path === field.path ? field : { ...field, path })
    }
    return [...output.values()]
  }
  const input = fieldsForStep(workflow, catalogs, dataSources, step.input, visited)
  if (step.kind === 'parseDocuments') {
    return step.config.columns.map((column) =>
      derivedField(column.name, column.dataType === 'datetime' ? 'string' : column.dataType))
  }
  if (step.kind === 'filterSelect') {
    return step.config.columns.length
      ? step.config.columns.flatMap((path) => input.find((field) => field.path === path) ?? [])
      : input
  }
  if (step.kind === 'derive') {
    const type = step.config.operation === 'toString' ? 'string' : 'number'
    return [...input.filter((field) => field.path !== step.config.output), derivedField(step.config.output, type)]
  }
  if (step.kind === 'aggregate') {
    const group = step.config.groupBy ? input.find((field) => field.path === step.config.groupBy) : undefined
    return [...(group ? [group] : []), derivedField(aggregateOutputColumn(step.config), 'number')]
  }
  return input
}

export function outputDataModel(
  workflow: Workflow,
  dataSources: DataSource[],
  stepId: string | null,
  visited = new Set<string>(),
): DataModel | 'csv' | undefined {
  if (!stepId || visited.has(stepId)) return undefined
  visited.add(stepId)
  const step = workflow.steps.find((item) => item.id === stepId)
  if (!step) return undefined
  if (step.kind === 'query') {
    const source = dataSources.find((item) => item.id === step.config.source)
    if (source?.type === 'cloudwatch-logs' && step.config.template) {
      return source.queryTemplates.find((template) => template.id === step.config.template?.id)?.outputDataModel
    }
    return source?.dataModel
  }
  if (step.kind === 'parseDocuments') return 'table'
  if (step.kind === 'csv') return 'csv'
  if (step.kind === 'preview') return outputDataModel(workflow, dataSources, step.input, visited)
  return 'table'
}

export function requiredInputDataModel(kind: WorkflowStep['kind']): DataModel | 'any' | undefined {
  if (kind === 'query') return undefined
  if (kind === 'parseDocuments') return 'documents'
  if (kind === 'preview') return 'any'
  return 'table'
}

export function createWorkflowStepId(kind: WorkflowStep['kind'], now = Date.now()): string {
  const normalizedKind = kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  return `${normalizedKind}-${now.toString(36)}`
}

export function workflowHistoryReducer(state: WorkflowHistory, action: WorkflowHistoryAction): WorkflowHistory {
  if (action.type === 'reset') return { past: [], present: action.workflow, future: [] }
  if (action.type === 'undo') {
    const previous = state.past.at(-1)
    return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] } : state
  }
  if (action.type === 'redo') {
    const next = state.future[0]
    return next ? { past: [...state.past, state.present].slice(-50), present: next, future: state.future.slice(1) } : state
  }
  const next = typeof action.update === 'function' ? action.update(state.present) : action.update
  if (next === state.present || workflowsEqual(next, state.present)) return state
  return { past: [...state.past, state.present].slice(-50), present: next, future: [] }
}

export function disconnectEdge(workflow: Workflow, edge: Edge): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      if (step.id !== edge.target) return step
      if ('inputs' in step) {
        const side = edge.targetHandle === 'right' ? 'right' : 'left'
        return step.inputs[side] === edge.source ? { ...step, inputs: { ...step.inputs, [side]: null } } : step
      }
      return 'input' in step && step.input === edge.source ? { ...step, input: null } : step
    }),
  }
}

export function connectNodes(workflow: Workflow, connection: Connection): Workflow {
  if (!connection.source || !connection.target) return workflow
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      if (step.id !== connection.target) return step
      if ('inputs' in step) {
        return { ...step, inputs: { ...step.inputs, [connection.targetHandle === 'right' ? 'right' : 'left']: connection.source } }
      }
      return 'input' in step ? { ...step, input: connection.source } : step
    }),
  }
}

export function duplicateWorkflowStep(workflow: Workflow, stepId: string, newId: string): Workflow {
  const index = workflow.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return workflow
  const duplicate = structuredClone(workflow.steps[index]!)
  duplicate.id = newId
  duplicate.title = `${duplicate.title} のコピー`
  return { ...workflow, steps: [...workflow.steps.slice(0, index + 1), duplicate, ...workflow.steps.slice(index + 1)] }
}

export function instantiateWorkflowTemplate(template: Workflow): Workflow {
  return { ...structuredClone(template), id: `wf_${crypto.randomUUID().replaceAll('-', '')}` }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

export function workflowsEqual(left: Workflow, right: Workflow): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}
