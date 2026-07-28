import type { CSSProperties } from 'react'
import {
  ControlButton,
  Controls,
  Handle,
  MarkerType,
  Position,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  ArrowDownWideNarrow,
  Braces,
  Calculator,
  Check,
  CircleAlert,
  Database,
  FileDown,
  GitMerge,
  ListFilter,
  Maximize2,
  Sigma,
  Table2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { Workflow, WorkflowRun, WorkflowStep } from '../shared/workflow'
import type { DataSource } from './api'

export type WorkflowNodeData = {
  label: string
  subtitle: string
  kind: WorkflowStep['kind']
  status?: 'completed'
  invalid?: boolean
  missingInput?: boolean
  missingLeft?: boolean
  missingRight?: boolean
}

export type FlowNode = Node<WorkflowNodeData>

export const workflowNodeMeta = {
  query: { eyebrow: 'DATA SOURCE', icon: Database, color: '#67a2d4' },
  parseDocuments: { eyebrow: 'PARSE', icon: Braces, color: '#4d91a8' },
  filterSelect: { eyebrow: 'TRANSFORM', icon: ListFilter, color: '#8aa979' },
  derive: { eyebrow: 'TRANSFORM', icon: Calculator, color: '#a7986d' },
  join: { eyebrow: 'MULTI-SOURCE', icon: GitMerge, color: '#a985ae' },
  aggregate: { eyebrow: 'TRANSFORM', icon: Sigma, color: '#c19a62' },
  joinAggregate: { eyebrow: 'MULTI-SOURCE', icon: GitMerge, color: '#b584a7' },
  sortLimit: { eyebrow: 'TRANSFORM', icon: ArrowDownWideNarrow, color: '#799eaa' },
  preview: { eyebrow: 'OUTPUT', icon: Table2, color: '#70a990' },
  csv: { eyebrow: 'OUTPUT', icon: FileDown, color: '#8d88bd' },
} as const

function WorkflowNode({ data, selected }: NodeProps<FlowNode>) {
  const meta = workflowNodeMeta[data.kind]
  const Icon = meta.icon
  return (
    <div className={`flow-node ${selected ? 'selected' : ''} ${data.invalid ? 'invalid' : ''}`}
      style={{ '--node-accent': meta.color } as CSSProperties}>
      {data.kind === 'joinAggregate' || data.kind === 'join'
        ? <><Handle id="left" className={data.missingLeft ? 'missing-handle' : ''} type="target" position={Position.Left} style={{ top: '38%' }} />
          <Handle id="right" className={data.missingRight ? 'missing-handle' : ''} type="target" position={Position.Left} style={{ top: '72%' }} /></>
        : data.kind !== 'query' && <Handle className={data.missingInput ? 'missing-handle' : ''} type="target" position={Position.Left} />}
      <div className="node-topline">
        <span className="node-icon"><Icon size={15} strokeWidth={2.2} /></span>
        <span>{meta.eyebrow}</span>
        {data.status === 'completed' ? <span className="node-complete"><Check size={12} /></span> : null}
        {data.invalid ? <span className="node-invalid"><CircleAlert size={12} /> 要設定</span> : null}
      </div>
      <strong>{data.label}</strong>
      <small>{data.subtitle}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

export const workflowNodeTypes = { workflow: WorkflowNode }

export function LabeledFlowControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  return <Controls className="labeled-flow-controls" showZoom={false} showFitView={false} showInteractive={false}>
    <ControlButton aria-label="拡大" onClick={() => void zoomIn()}><ZoomIn size={14} /><span>拡大</span></ControlButton>
    <ControlButton aria-label="縮小" onClick={() => void zoomOut()}><ZoomOut size={14} /><span>縮小</span></ControlButton>
    <ControlButton aria-label="全体表示" onClick={() => void fitView({ padding: 0.22 })}><Maximize2 size={14} /><span>全体表示</span></ControlButton>
  </Controls>
}

function stepSubtitle(step: WorkflowStep): string {
  if (step.kind === 'query') return step.config.source === 'unconfigured' ? '接続先を登録してください'
    : step.config.template ? `${step.config.source} / ${step.config.template.id}` : step.config.source
  if (step.kind === 'parseDocuments') return step.input
    ? `${step.config.recordPath} → ${step.config.columns.length}列` : 'JSONライク形式の入力が必要です'
  if (step.kind === 'filterSelect') return step.input
    ? `${step.config.filters.length}条件 / ${step.config.columns.length || '全'}列` : '入力が接続されていません'
  if (step.kind === 'derive') return step.input
    ? `${step.config.output} ← ${step.config.operation}(${step.config.source})` : '入力が接続されていません'
  if (step.kind === 'join') return step.inputs.left && step.inputs.right
    ? `${step.config.leftKey} = ${step.config.rightKey} / ${step.config.joinType}` : '左右の入力を接続してください'
  if (step.kind === 'aggregate') return step.input
    ? `${step.config.groupBy ?? '全体'} / ${step.config.operation}(${step.config.metric ?? '行'})` : '入力が接続されていません'
  if (step.kind === 'joinAggregate') return step.inputs.left && step.inputs.right
    ? `${step.config.leftKey} = ${step.config.rightKey} → ${step.config.groupBy}` : '左右の入力を接続してください'
  if (step.kind === 'sortLimit') return step.input
    ? `${step.config.sortBy} ${step.config.direction} / ${step.config.limit}件` : '入力が接続されていません'
  if (step.kind === 'preview') return step.input ? `先頭 ${step.config.limit} 行` : '入力が接続されていません'
  return step.input ? step.config.fileName : '入力が接続されていません'
}

const positions: Record<WorkflowStep['kind'], { x: number; y: number }> = {
  query: { x: 40, y: 150 },
  parseDocuments: { x: 250, y: 150 },
  filterSelect: { x: 280, y: 70 },
  derive: { x: 350, y: 180 },
  join: { x: 420, y: 300 },
  aggregate: { x: 320, y: 150 },
  joinAggregate: { x: 400, y: 320 },
  sortLimit: { x: 520, y: 170 },
  preview: { x: 600, y: 45 },
  csv: { x: 600, y: 260 },
}

function stepNeedsConfiguration(step: WorkflowStep, workflow: Workflow, dataSources: DataSource[]): boolean {
  const stepIndex = workflow.steps.findIndex((item) => item.id === step.id)
  const priorStepIds = new Set(workflow.steps.slice(0, stepIndex).map((item) => item.id))
  if (step.kind === 'query') {
    const source = dataSources.find((item) => item.id === step.config.source)
    if (!source) return true
    if (source.type !== 'cloudwatch-logs' || source.queryMode !== 'template-required') return false
    const template = source.queryTemplates.find((item) => item.id === step.config.template?.id)
    return !template || template.variables.some((variable) => variable.required
      && (step.config.template?.arguments[variable.id] === undefined || step.config.template.arguments[variable.id] === ''))
  }
  if (step.kind === 'joinAggregate' || step.kind === 'join') {
    return !step.inputs.left || !step.inputs.right || !priorStepIds.has(step.inputs.left) || !priorStepIds.has(step.inputs.right)
      || step.inputs.left === step.inputs.right
      || Object.values(step.config).some((value) => typeof value === 'string' && !value.trim())
  }
  if (!step.input || !priorStepIds.has(step.input)) return true
  if (step.kind === 'parseDocuments') return !step.config.recordPath.trim() || step.config.columns.length === 0
  if (step.kind === 'aggregate') return step.config.operation !== 'count' && !step.config.metric
  if (step.kind === 'derive') return !step.config.output.trim() || !step.config.source.trim()
  if (step.kind === 'sortLimit') return !step.config.sortBy.trim()
  if (step.kind === 'csv') return !step.config.fileName.trim()
  return false
}

export function workflowToNodes(workflow: Workflow, run?: WorkflowRun, dataSources: DataSource[] = []): FlowNode[] {
  const countByKind = new Map<WorkflowStep['kind'], number>()
  const priorStepIds = new Set<string>()
  return workflow.steps.map((step) => {
    const index = countByKind.get(step.kind) ?? 0
    countByKind.set(step.kind, index + 1)
    const base = positions[step.kind]
    const node: FlowNode = {
      id: step.id,
      type: 'workflow',
      position: { x: base.x + index * 32, y: base.y + index * 118 },
      data: {
        label: step.title,
        subtitle: stepSubtitle(step),
        kind: step.kind,
        invalid: stepNeedsConfiguration(step, workflow, dataSources),
        missingInput: 'input' in step && (!step.input || !priorStepIds.has(step.input)),
        missingLeft: 'inputs' in step && (!step.inputs.left || !priorStepIds.has(step.inputs.left)),
        missingRight: 'inputs' in step && (!step.inputs.right || !priorStepIds.has(step.inputs.right)),
        status: run?.steps.some((item) => item.stepId === step.id && item.status === 'completed') ? 'completed' : undefined,
      },
    }
    priorStepIds.add(step.id)
    return node
  })
}

const edgeStyle = { stroke: '#9aa7b7', strokeWidth: 1.6 }
const edgeMarker = { type: MarkerType.ArrowClosed, color: '#9aa7b7' }

export function workflowToEdges(workflow: Workflow): Edge[] {
  const edges: Edge[] = []
  for (const step of workflow.steps) {
    if ('inputs' in step) {
      if (step.inputs.left) edges.push({ id: `${step.inputs.left}-${step.id}-left`, source: step.inputs.left, target: step.id,
        targetHandle: 'left', markerEnd: edgeMarker, style: edgeStyle })
      if (step.inputs.right) edges.push({ id: `${step.inputs.right}-${step.id}-right`, source: step.inputs.right, target: step.id,
        targetHandle: 'right', markerEnd: edgeMarker, style: edgeStyle })
    } else if ('input' in step && step.input) {
      edges.push({ id: `${step.input}-${step.id}`, source: step.input, target: step.id, markerEnd: edgeMarker, style: edgeStyle })
    }
  }
  return edges
}
