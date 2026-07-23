import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import {
  Braces,
  BookOpenCheck,
  Calculator,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  FileDown,
  GitMerge,
  Layers3,
  Link2Off,
  ListFilter,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Play,
  Plus,
  Redo2,
  Save,
  Sigma,
  ArrowDownWideNarrow,
  Table2,
  Trash2,
  Undo2,
  Workflow as WorkflowIcon,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react'
import {
  deleteWorkflowSteps,
  sampleWorkflow,
  type ArtifactSummary,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '../shared/workflow'
import {
  archiveWorkflow,
  executeWorkflow,
  loadInitialAuth,
  loadBootstrap,
  loadConversation,
  loadCatalogs,
  loadWorkflowVersions,
  logout as logoutSession,
  linkConversationWorkflow,
  respondToAgent,
  requestWorkflowRunApproval,
  saveWorkflow,
  type AuthProvider,
  type AuthSession,
  type DataSource,
  type SavedWorkflow,
  type WorkflowListItem,
} from './api'
import type { CatalogField, CatalogVersion } from '../shared/catalog'
import { LoginView } from './LoginView'
import { ConnectionManager } from './ConnectionManager'
import type { AgentProviderStatus, AgentResponse } from '../shared/api'
import { WorkflowTransferActions } from './WorkflowTransferActions'
import { OperationsPanel } from './OperationsPanel'
import { ArtifactDownloadButton } from './ArtifactDownloadButton'
import { WorkflowManager } from './WorkflowManager'
import { ApprovalSummary } from './ApprovalSummary'
import { ChatWorkspace, type ChatViewMessage } from './ChatWorkspace'

const CatalogManager = lazy(() => import('./CatalogManager').then((module) => ({ default: module.CatalogManager })))

type WorkflowNodeData = {
  label: string
  subtitle: string
  kind: WorkflowStep['kind']
  status?: 'completed'
  invalid?: boolean
  missingInput?: boolean
  missingLeft?: boolean
  missingRight?: boolean
}

type FlowNode = Node<WorkflowNodeData>

function sourceIdsForStep(workflow: Workflow, stepId: string | null, visited = new Set<string>()): string[] {
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

function fieldsForStep(workflow: Workflow, catalogs: CatalogVersion[], stepId: string | null, visited = new Set<string>()): CatalogField[] {
  if (!stepId || visited.has(stepId)) return []
  visited.add(stepId)
  const step = workflow.steps.find((item) => item.id === stepId)
  if (!step) return []
  if (step.kind === 'query') return catalogs.find((catalog) => catalog.sourceId === step.config.source)?.definition.fields ?? []
  if ('inputs' in step) {
    const left = fieldsForStep(workflow, catalogs, step.inputs.left, new Set(visited))
    const right = fieldsForStep(workflow, catalogs, step.inputs.right, new Set(visited))
    if (step.kind === 'joinAggregate') {
      const group = right.find((field) => field.path === step.config.groupBy)
      return [...(group ? [group] : []), derivedField(`${step.config.operation}_${step.config.metric}`, 'number')]
    }
    const output = new Map(left.map((field) => [field.path, field]))
    for (const field of right) output.set(output.has(field.path) ? `right.${field.path}` : field.path,
      output.has(field.path) ? { ...field, path: `right.${field.path}` } : field)
    return [...output.values()]
  }
  const input = fieldsForStep(workflow, catalogs, step.input, visited)
  if (step.kind === 'filterSelect') return step.config.columns.length
    ? step.config.columns.flatMap((path) => input.find((field) => field.path === path) ?? []) : input
  if (step.kind === 'derive') {
    const type = step.config.operation === 'toString' ? 'string' : 'number'
    return [...input.filter((field) => field.path !== step.config.output), derivedField(step.config.output, type)]
  }
  if (step.kind === 'aggregate') {
    const group = input.find((field) => field.path === step.config.groupBy)
    return [...(group ? [group] : []), derivedField(`${step.config.operation}_${step.config.metric}`, 'number')]
  }
  return input
}

function derivedField(path: string, type: CatalogField['dataTypes'][number]): CatalogField {
  return { path, dataTypes: [type], nullable: false, presence: 1, businessName: '', description: '', unit: '', timezone: '' }
}

function CatalogFieldSelect({ label, value, fields, numeric, onChange, onOpenCatalog }: {
  label: string; value: string; fields: CatalogField[]; numeric?: boolean; onChange(value: string): void; onOpenCatalog(): void
}) {
  const candidates = numeric ? fields.filter((field) => field.dataTypes.includes('number')) : fields
  if (candidates.length === 0) return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} />
    <button type="button" className="catalog-inline-link" onClick={onOpenCatalog}>Catalogを確認・探索</button></label>
  const known = candidates.some((field) => field.path === value)
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    {!known && <option value={value}>{value}（Catalog未登録）</option>}
    {candidates.map((field) => <option key={field.path} value={field.path}>{field.businessName ? `${field.businessName} · ` : ''}{field.path} ({field.dataTypes.join('/')})</option>)}
  </select></label>
}

function LabeledFlowControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()

  return <Controls className="labeled-flow-controls" showZoom={false} showFitView={false} showInteractive={false}>
    <ControlButton aria-label="拡大" onClick={() => void zoomIn()}><ZoomIn size={14} /><span>拡大</span></ControlButton>
    <ControlButton aria-label="縮小" onClick={() => void zoomOut()}><ZoomOut size={14} /><span>縮小</span></ControlButton>
    <ControlButton aria-label="全体表示" onClick={() => void fitView({ padding: 0.22 })}><Maximize2 size={14} /><span>全体表示</span></ControlButton>
  </Controls>
}

const kindMeta = {
  query: { eyebrow: 'DATA SOURCE', icon: Database, color: '#67a2d4' },
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
  const meta = kindMeta[data.kind]
  const Icon = meta.icon
  return (
    <div className={`flow-node ${selected ? 'selected' : ''} ${data.invalid ? 'invalid' : ''}`} style={{ '--node-accent': meta.color } as React.CSSProperties}>
      {data.kind === 'joinAggregate' || data.kind === 'join'
        ? <><Handle id="left" className={data.missingLeft ? 'missing-handle' : ''} type="target" position={Position.Left} style={{ top: '38%' }} /><Handle id="right" className={data.missingRight ? 'missing-handle' : ''} type="target" position={Position.Left} style={{ top: '72%' }} /></>
        : data.kind !== 'query' && <Handle className={data.missingInput ? 'missing-handle' : ''} type="target" position={Position.Left} />}
      <div className="node-topline">
        <span className="node-icon"><Icon size={15} strokeWidth={2.2} /></span>
        <span>{meta.eyebrow}</span>
        {data.status === 'completed' && <span className="node-complete"><Check size={12} /></span>}
        {data.invalid && <span className="node-invalid"><CircleAlert size={12} /> 要設定</span>}
      </div>
      <strong>{data.label}</strong>
      <small>{data.subtitle}</small>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { workflow: WorkflowNode }

function stepSubtitle(step: WorkflowStep): string {
  if (step.kind === 'query') return step.config.source === 'unconfigured' ? '接続先を登録してください' : step.config.source
  if (step.kind === 'filterSelect') return step.input ? `${step.config.filters.length}条件 / ${step.config.columns.length || '全'}列` : '入力が接続されていません'
  if (step.kind === 'derive') return step.input ? `${step.config.output} ← ${step.config.operation}(${step.config.source})` : '入力が接続されていません'
  if (step.kind === 'join') return step.inputs.left && step.inputs.right ? `${step.config.leftKey} = ${step.config.rightKey} / ${step.config.joinType}` : '左右の入力を接続してください'
  if (step.kind === 'aggregate') return step.input ? `${step.config.groupBy} / ${step.config.operation}(${step.config.metric})` : '入力が接続されていません'
  if (step.kind === 'joinAggregate') return step.inputs.left && step.inputs.right ? `${step.config.leftKey} = ${step.config.rightKey} → ${step.config.groupBy}` : '左右の入力を接続してください'
  if (step.kind === 'sortLimit') return step.input ? `${step.config.sortBy} ${step.config.direction} / ${step.config.limit}件` : '入力が接続されていません'
  if (step.kind === 'preview') return step.input ? `先頭 ${step.config.limit} 行` : '入力が接続されていません'
  if (!step.input) return '入力が接続されていません'
  return step.config.fileName
}

const positions: Record<WorkflowStep['kind'], { x: number; y: number }> = {
  query: { x: 40, y: 150 },
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
  const stepIds = new Set(workflow.steps.slice(0, stepIndex).map((item) => item.id))
  if (step.kind === 'query') return step.config.source === 'unconfigured' || !dataSources.some((source) => source.id === step.config.source)
  if (step.kind === 'joinAggregate' || step.kind === 'join') return !step.inputs.left || !step.inputs.right || !stepIds.has(step.inputs.left) || !stepIds.has(step.inputs.right)
    || step.inputs.left === step.inputs.right || Object.values(step.config).some((value) => typeof value === 'string' && !value.trim())
  if (!step.input || !stepIds.has(step.input)) return true
  if (step.kind === 'aggregate') return !step.config.groupBy.trim() || !step.config.metric.trim()
  if (step.kind === 'derive') return !step.config.output.trim() || !step.config.source.trim()
  if (step.kind === 'sortLimit') return !step.config.sortBy.trim()
  if (step.kind === 'csv') return !step.config.fileName.trim()
  return false
}

function workflowToNodes(workflow: Workflow, run?: WorkflowRun, dataSources: DataSource[] = []): FlowNode[] {
  const countByKind = new Map<string, number>()
  return workflow.steps.map((step) => {
    const index = countByKind.get(step.kind) ?? 0
    countByKind.set(step.kind, index + 1)
    const base = positions[step.kind]
    const priorIds = new Set(workflow.steps.slice(0, workflow.steps.findIndex((item) => item.id === step.id)).map((item) => item.id))
    return {
      id: step.id,
      type: 'workflow',
      position: { x: base.x + index * 32, y: base.y + index * 118 },
      data: {
        label: step.title,
        subtitle: stepSubtitle(step),
        kind: step.kind,
        invalid: stepNeedsConfiguration(step, workflow, dataSources),
        missingInput: 'input' in step && (!step.input || !priorIds.has(step.input)),
        missingLeft: 'inputs' in step && (!step.inputs.left || !priorIds.has(step.inputs.left)),
        missingRight: 'inputs' in step && (!step.inputs.right || !priorIds.has(step.inputs.right)),
        status: run?.steps.some((item) => item.stepId === step.id && item.status === 'completed') ? 'completed' : undefined,
      },
    }
  })
}

function workflowToEdges(workflow: Workflow): Edge[] {
  const edges: Edge[] = []
  for (const step of workflow.steps) {
    if ('inputs' in step) {
      if (step.inputs.left) edges.push({ id: `${step.inputs.left}-${step.id}-left`, source: step.inputs.left, target: step.id, targetHandle: 'left', markerEnd: { type: MarkerType.ArrowClosed, color: '#9aa7b7' }, style: { stroke: '#9aa7b7', strokeWidth: 1.6 } })
      if (step.inputs.right) edges.push({ id: `${step.inputs.right}-${step.id}-right`, source: step.inputs.right, target: step.id, targetHandle: 'right', markerEnd: { type: MarkerType.ArrowClosed, color: '#9aa7b7' }, style: { stroke: '#9aa7b7', strokeWidth: 1.6 } })
    } else if ('input' in step && step.input) {
      edges.push({ id: `${step.input}-${step.id}`, source: step.input, target: step.id, markerEnd: { type: MarkerType.ArrowClosed, color: '#9aa7b7' }, style: { stroke: '#9aa7b7', strokeWidth: 1.6 } })
    }
  }
  return edges
}

type WorkflowHistory = { past: Workflow[]; present: Workflow; future: Workflow[] }
type WorkflowHistoryAction =
  | { type: 'edit'; update: Workflow | ((current: Workflow) => Workflow) }
  | { type: 'reset'; workflow: Workflow }
  | { type: 'undo' }
  | { type: 'redo' }

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
  if (next === state.present || JSON.stringify(next) === JSON.stringify(state.present)) return state
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
      if ('inputs' in step) return { ...step, inputs: { ...step.inputs, [connection.targetHandle === 'right' ? 'right' : 'left']: connection.source! } }
      return 'input' in step ? { ...step, input: connection.source! } : step
    }),
  }
}

export function duplicateWorkflowStep(workflow: Workflow, stepId: string, newId: string): Workflow {
  const index = workflow.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return workflow
  const original = workflow.steps[index]!
  const duplicate = { ...structuredClone(original), id: newId, title: `${original.title} のコピー` } as WorkflowStep
  return { ...workflow, steps: [...workflow.steps.slice(0, index + 1), duplicate, ...workflow.steps.slice(index + 1)] }
}

export function instantiateWorkflowTemplate(template: Workflow): Workflow {
  return { ...structuredClone(template), id: `wf_${crypto.randomUUID().replaceAll('-', '')}` }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]))
  return value
}

export function workflowsEqual(left: Workflow, right: Workflow): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
}

export function App() {
  const [auth, setAuth] = useState<AuthSession | null>()
  const [providers, setProviders] = useState<AuthProvider[]>([])
  const [loginError, setLoginError] = useState<string>()
  const [workflowHistory, dispatchWorkflow] = useReducer(workflowHistoryReducer, { past: [], present: sampleWorkflow, future: [] })
  const workflow = workflowHistory.present
  const setWorkflow = useCallback((update: Workflow | ((current: Workflow) => Workflow)) => dispatchWorkflow({ type: 'edit', update }), [])
  const [nodes, setNodes] = useState<FlowNode[]>(() => workflowToNodes(sampleWorkflow))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const pendingCanvasDelete = useRef<{ nodeIds: Set<string>; edgeIds: Set<string> } | null>(null)
  const [prompt, setPrompt] = useState('')
  const [planning, setPlanning] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedWorkflow, setSavedWorkflow] = useState<SavedWorkflow>()
  const [workflowLibrary, setWorkflowLibrary] = useState<WorkflowListItem[]>([])
  const [workflowVersions, setWorkflowVersions] = useState<SavedWorkflow[]>([])
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; workflowId: string | null; updatedAt: string }>>([])
  const [agentProvider, setAgentProvider] = useState<AgentProviderStatus>({ provider: 'disabled', label: 'モデルAPI未設定', configured: false })
  const [run, setRun] = useState<WorkflowRun>()
  const [notice, setNotice] = useState<string>()
  const [chatOpen, setChatOpen] = useState(true)
  const [dataSources, setDataSources] = useState<DataSource[]>([])
  const [catalogs, setCatalogs] = useState<CatalogVersion[]>([])
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [workflowManagerOpen, setWorkflowManagerOpen] = useState(false)
  const [messages, setMessages] = useState<ChatViewMessage[]>([])
  const [conversationId, setConversationId] = useState<string>()
  const [proposal, setProposal] = useState<Extract<AgentResponse, { state: 'proposal' }>>()
  const [runApproval, setRunApproval] = useState<{ id: string; expiresAt: string; summary: Record<string, unknown>; saved: SavedWorkflow }>()
  const edges = useMemo<Edge[]>(() => workflowToEdges(workflow).map((edge) => ({ ...edge, selected: edge.id === selectedEdgeId })), [workflow, selectedEdgeId])

  useEffect(() => {
    setNodes((current) => {
      const previousPositions = new Map(current.map((node) => [node.id, node.position]))
      return workflowToNodes(workflow, run, dataSources).map((node) => ({ ...node, position: previousPositions.get(node.id) ?? node.position }))
    })
  }, [workflow, run, dataSources])

  useEffect(() => {
    if (selectedEdgeId && !edges.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null)
  }, [edges, selectedEdgeId])

  useEffect(() => {
    let active = true
    void loadInitialAuth().then(async ({ session, providers: availableProviders }) => {
      if (!active) return
      setProviders(availableProviders)
      setAuth(session)
      if (!session) return
      const bootstrap = await loadBootstrap()
      if (!active) return
      setDataSources(bootstrap.dataSources)
      setCatalogs(bootstrap.catalogs)
      setWorkflowLibrary(bootstrap.workflows)
      setConversations(bootstrap.conversations)
      setAgentProvider(bootstrap.agent)
      const latest = bootstrap.workflows[0]
      dispatchWorkflow({ type: 'reset', workflow: latest?.workflow ?? instantiateWorkflowTemplate(bootstrap.workflowTemplate) })
      if (latest) {
        const versions = await loadWorkflowVersions(latest.workflow.id)
        if (!active) return
        setWorkflowVersions(versions.versions); setSavedWorkflow(versions.versions[0])
      }
    }).catch((error) => {
      if (!active) return
      setLoginError(error instanceof Error ? error.message : 'アプリを初期化できませんでした。')
      setAuth(null)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault(); dispatchWorkflow({ type: 'undo' }); setRun(undefined)
      } else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault(); dispatchWorkflow({ type: 'redo' }); setRun(undefined)
      }
    }
    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [])

  async function logout() {
    if (!auth) return
    const signedOut = await logoutSession(auth)
    window.location.assign(signedOut.redirectUrl)
  }

  const selectedStep = workflow.steps.find((step) => step.id === selectedId)
  const resultArtifact = useMemo<ArtifactSummary | undefined>(() =>
    run ? [...run.steps].reverse().find((step) => step.artifact.preview)?.artifact : undefined,
  [run])
  const csvArtifact = run?.steps.find((step) => step.artifact.type === 'csv')?.artifact
  const activeSourceId = workflow.steps.find((step) => step.kind === 'query')?.config.source
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId)
  const availableInputs = selectedStep
    ? workflow.steps.slice(0, workflow.steps.findIndex((step) => step.id === selectedStep.id)).filter((step) => step.kind !== 'csv')
    : []
  const selectedInputFields = selectedStep && 'input' in selectedStep ? fieldsForStep(workflow, catalogs, selectedStep.input) : []
  const aggregateFields = selectedStep?.kind === 'aggregate' ? fieldsForStep(workflow, catalogs, selectedStep.input) : []
  const leftJoinFields = selectedStep && (selectedStep.kind === 'joinAggregate' || selectedStep.kind === 'join') ? fieldsForStep(workflow, catalogs, selectedStep.inputs.left) : []
  const rightJoinFields = selectedStep && (selectedStep.kind === 'joinAggregate' || selectedStep.kind === 'join') ? fieldsForStep(workflow, catalogs, selectedStep.inputs.right) : []
  const workflowDirty = !savedWorkflow || savedWorkflow.workflow.id !== workflow.id
    || !workflowsEqual(savedWorkflow.workflow, workflow)

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((items) => applyNodeChanges(changes, items))
  }, [])
  const onNodesDelete = useCallback((deletedNodes: FlowNode[]) => {
    const deletedIds = new Set(deletedNodes.map((node) => node.id))
    const pending = pendingCanvasDelete.current
    if (pending && [...deletedIds].every((id) => pending.nodeIds.has(id))) {
      for (const id of deletedIds) pending.nodeIds.delete(id)
      if (pending.nodeIds.size === 0 && pending.edgeIds.size === 0) pendingCanvasDelete.current = null
      return
    }
    setWorkflow((current) => deleteWorkflowSteps(current, [...deletedIds]))
    setSelectedId((current) => current && deletedIds.has(current) ? null : current)
    setSelectedEdgeId(null)
    setRun(undefined)
    setNotice(`${deletedIds.size}件のノードを削除しました。後続ノードの入力は未接続として保持されます。`)
  }, [setWorkflow])
  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    setWorkflow((current) => connectNodes(current, connection))
    setRun(undefined)
  }, [setWorkflow])

  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    const pending = pendingCanvasDelete.current
    if (pending && deletedEdges.every((edge) => pending.edgeIds.has(edge.id))) {
      for (const edge of deletedEdges) pending.edgeIds.delete(edge.id)
      if (pending.nodeIds.size === 0 && pending.edgeIds.size === 0) pendingCanvasDelete.current = null
      return
    }
    setWorkflow((current) => deletedEdges.reduce(disconnectEdge, current))
    setSelectedEdgeId(null)
    setRun(undefined)
  }, [setWorkflow])

  const onBeforeDelete = useCallback(async ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: FlowNode[]; edges: Edge[] }) => {
    if (deletedNodes.length === 0 && deletedEdges.length === 0) return true
    pendingCanvasDelete.current = {
      nodeIds: new Set(deletedNodes.map((node) => node.id)),
      edgeIds: new Set(deletedEdges.map((edge) => edge.id)),
    }
    window.setTimeout(() => { pendingCanvasDelete.current = null }, 0)
    if (deletedNodes.length > 0) {
      const ids = deletedNodes.map((node) => node.id)
      setWorkflow((current) => deleteWorkflowSteps(current, ids))
      setSelectedId(null)
      setSelectedEdgeId(null)
      setNotice(`${ids.length}件のノードを削除しました。後続ノードの入力は未接続として保持されます。`)
    } else {
      setWorkflow((current) => deletedEdges.reduce(disconnectEdge, current))
      setSelectedEdgeId(null)
    }
    setRun(undefined)
    return true
  }, [setWorkflow])

  const onReconnect = useCallback((oldEdge: Edge, connection: Connection) => {
    setWorkflow((current) => connectNodes(disconnectEdge(current, oldEdge), connection))
    setSelectedEdgeId(null)
    setRun(undefined)
  }, [setWorkflow])

  function deleteSelectedEdge() {
    const edge = edges.find((item) => item.id === selectedEdgeId)
    if (!edge) return
    onEdgesDelete([edge])
  }

  function selectNode(node: FlowNode) {
    setSelectedId(node.id)
    setSelectedEdgeId(null)
  }

  async function sendPrompt(text = prompt) {
    const trimmed = text.trim()
    if (!trimmed || planning) return
    setPrompt('')
    setPlanning(true)
    setProposal(undefined)
    const clientMessageId = crypto.randomUUID()
    setMessages((items) => [...items, { id: `local-user-${clientMessageId}`, role: 'user', text: trimmed }])
    try {
      if (!auth) throw new Error('ログインが必要です。')
      const result = await respondToAgent(auth, { message: trimmed, workflow, conversationId, clientMessageId })
      setCatalogs((await loadCatalogs(auth)).catalogs)
      const { conversationId: nextConversationId, provider: _provider, ...metadata } = result
      setConversationId(nextConversationId)
      setMessages((items) => [...items, { id: `local-agent-${clientMessageId}`, role: 'agent', text: result.message, metadata }])
      if (result.state === 'proposal') setProposal(result)
      setConversations((items) => [{ id: nextConversationId, title: items.find((item) => item.id === nextConversationId)?.title ?? trimmed.slice(0, 80),
        workflowId: items.find((item) => item.id === nextConversationId)?.workflowId ?? null, updatedAt: new Date().toISOString() },
      ...items.filter((item) => item.id !== nextConversationId)])
    } catch (error) {
      setMessages((items) => [...items, { id: `local-error-${clientMessageId}`, role: 'system',
        text: error instanceof Error ? error.message : String(error) }])
    } finally {
      setPlanning(false)
    }
  }

  async function applyProposal() {
    if (!auth || !proposal) return
    setPlanning(true)
    try {
      const saved = await saveWorkflow(auth, proposal.workflow, 'agent',
        workflowVersions[0]?.workflow.id === proposal.workflow.id ? workflowVersions[0].version
          : savedWorkflow?.workflow.id === proposal.workflow.id ? savedWorkflow.version : undefined)
      dispatchWorkflow({ type: 'edit', update: proposal.workflow })
      setRun(undefined); setSavedWorkflow(saved)
      if (!conversationId) throw new Error('提案に対応する会話が見つかりません。')
      const conversation = await linkConversationWorkflow(auth, conversationId, saved.workflow.id, saved.version)
      setProposal(undefined); setNotice(`エージェントの提案をv${saved.version}として適用しました。`)
      setMessages((items) => [...items, { id: `system-applied-${saved.version}-${Date.now()}`, role: 'system',
        text: `提案を「${saved.workflow.name}」v${saved.version}として保存しました。ノードUIで確認・修正できます。` }])
      setWorkflowVersions((items) => [saved, ...items.filter((item) => item.workflow.id === saved.workflow.id && item.version !== saved.version)])
      setConversations((items) => items.map((item) => item.id === conversation.id
        ? { ...item, workflowId: saved.workflow.id, updatedAt: new Date().toISOString() } : item))
      setWorkflowLibrary((items) => [{ workflow: saved.workflow, version: saved.version, status: saved.status, updatedAt: saved.updatedAt },
        ...items.filter((item) => item.workflow.id !== saved.workflow.id)])
    } catch (error) { setMessages((items) => [...items, { id: `system-apply-error-${Date.now()}`, role: 'system', text: error instanceof Error ? error.message : String(error) }]) }
    finally { setPlanning(false) }
  }

  async function persistWorkflow(changeSource: 'manual' | 'agent' = 'manual') {
    if (!auth) throw new Error('ログインが必要です。')
    setSaving(true)
    try {
      const currentVersion = workflowVersions[0]?.workflow.id === workflow.id ? workflowVersions[0].version
        : savedWorkflow?.workflow.id === workflow.id ? savedWorkflow.version : undefined
      const saved = await saveWorkflow(auth, workflow, changeSource, currentVersion)
      setSavedWorkflow(saved)
      setWorkflowVersions((items) => [saved, ...items.filter((item) => item.workflow.id === saved.workflow.id && item.version !== saved.version)])
      setWorkflowLibrary((items) => [{ workflow: saved.workflow, version: saved.version, status: saved.status, updatedAt: saved.updatedAt },
        ...items.filter((item) => item.workflow.id !== saved.workflow.id)])
      setNotice(saved.validation.valid
        ? `「${saved.workflow.name}」をバージョン ${saved.version} として保存しました。`
        : `ドラフトをバージョン ${saved.version} として保存しました。設定不足のノードがあります。`)
      return saved
    } finally {
      setSaving(false)
    }
  }

  async function saveFromToolbar() {
    setNotice(undefined)
    try {
      await persistWorkflow()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function execute() {
    setExecuting(true)
    setNotice(undefined)
    try {
      if (!auth) throw new Error('ログインが必要です。')
      if (!activeSourceId || !dataSources.some((source) => source.id === activeSourceId)) {
        throw new Error(auth.applicationRole === 'admin'
          ? 'データソース管理で接続を登録し、取得ノードで選択してください。'
          : '利用可能なデータソースがありません。管理者へ登録を依頼してください。')
      }
      const saved = savedWorkflow?.workflow.id === workflow.id && workflowsEqual(savedWorkflow.workflow, workflow)
        ? savedWorkflow : await persistWorkflow()
      if (!saved.validation.valid) throw new Error(saved.validation.errors.join(' '))
      if (saved.workflow.steps.some((step) => step.kind === 'csv')) {
        const approval = await requestWorkflowRunApproval(auth, saved.workflow.id, saved.version)
        setRunApproval({ ...approval, saved })
      } else {
        const result = await executeWorkflow(auth, saved.workflow.id, saved.version)
        setRun(result.run)
        setNotice(`${result.run.steps.length}ステップを ${result.run.durationMs}ms で実行しました。`)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setExecuting(false)
    }
  }

  async function confirmRunExport() {
    if (!auth || !runApproval) return
    const pending = runApproval
    setExecuting(true); setNotice(undefined)
    try {
      const result = await executeWorkflow(auth, pending.saved.workflow.id, pending.saved.version, pending.id)
      setRun(result.run); setRunApproval(undefined)
      setNotice(`${result.run.steps.length}ステップを ${result.run.durationMs}ms で実行しました。`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setExecuting(false) }
  }

  function updateStepConfig(key: string, value: unknown) {
    if (!selectedId) return
    setWorkflow((current) => ({
      ...current,
      steps: current.steps.map((step) => step.id === selectedId
        ? ({ ...step, config: { ...step.config, [key]: value } } as WorkflowStep)
        : step),
    }))
    setRun(undefined)
  }

  function addStep(kind: WorkflowStep['kind']) {
    const id = `${kind}-${Date.now().toString(36)}`
    if (kind === 'query') {
      const step: WorkflowStep = { id, kind, title: 'データソースから取得', config: { source: 'unconfigured', parameters: {} } }
      setWorkflow((current) => ({ ...current, steps: [...current.steps, step] }))
      setSelectedId(id)
      return
    }
    if (kind === 'joinAggregate' || kind === 'join') {
      const candidates = workflow.steps.filter((step) => step.kind !== 'csv')
      if (candidates.length < 2) { setNotice('結合には、先に2つ以上のデータ取得・変換ノードが必要です。'); return }
      const [left, right] = candidates.slice(-2)
      const leftFields = fieldsForStep(workflow, catalogs, left.id)
      const rightFields = fieldsForStep(workflow, catalogs, right.id)
      const leftSourceIds = sourceIdsForStep(workflow, left.id)
      const rightSourceIds = new Set(sourceIdsForStep(workflow, right.id))
      const suggestedRelationship = catalogs.filter((catalog) => leftSourceIds.includes(catalog.sourceId))
        .flatMap((catalog) => catalog.definition.relationships).find((relationship) => rightSourceIds.has(relationship.targetSourceId))
      const leftKey = suggestedRelationship?.localFields[0] ?? leftFields[0]?.path ?? 'id'
      const rightKey = suggestedRelationship?.targetFields[0] ?? rightFields[0]?.path ?? 'id'
      const step: WorkflowStep = kind === 'join'
        ? { id, kind, title: '2つのデータを結合', inputs: { left: left.id, right: right.id }, config: { leftKey, rightKey, joinType: 'inner' } }
        : { id, kind, title: '複数データを結合・集計', inputs: { left: left.id, right: right.id }, config: { leftKey, rightKey,
          groupBy: rightFields.find((field) => field.dataTypes.includes('string'))?.path ?? rightFields[0]?.path ?? 'category',
          metric: leftFields.find((field) => field.dataTypes.includes('number'))?.path ?? leftFields[0]?.path ?? 'value', operation: 'sum' } }
      setWorkflow((current) => ({ ...current, steps: [...current.steps, step] }))
      setSelectedId(id)
      return
    }
    const input = [...workflow.steps].reverse().find((step) => step.kind !== 'csv')?.id
    if (!input) return
    const inputFields = fieldsForStep(workflow, catalogs, input)
    const firstField = inputFields[0]?.path ?? 'value'
    const numericField = inputFields.find((field) => field.dataTypes.includes('number'))?.path ?? firstField
    const step: WorkflowStep = kind === 'filterSelect'
      ? { id, kind, title: '行を絞り込み・列を選択', input, config: { columns: [], filters: [] } }
      : kind === 'derive'
        ? { id, kind, title: '計算列を追加', input, config: { output: 'calculated_value', operation: 'toNumber', source: firstField, operandField: null, operandValue: null } }
      : kind === 'aggregate'
      ? { id, kind, title: '新しい集計', input, config: {
        groupBy: inputFields.find((field) => field.dataTypes.includes('string'))?.path ?? inputFields[0]?.path ?? 'category',
        metric: numericField, operation: 'sum' } }
      : kind === 'sortLimit'
        ? { id, kind, title: '並べ替え・件数制限', input, config: { sortBy: firstField, direction: 'asc', limit: 100 } }
      : kind === 'preview'
        ? { id, kind, title: '新しいプレビュー', input, config: { limit: 10 } }
        : { id, kind, title: '新しいCSV出力', input, config: { fileName: 'result.csv', mode: 'spreadsheet' } }
    setWorkflow((current) => ({ ...current, steps: [...current.steps, step] }))
    setSelectedId(id)
  }

  function removeSelected() {
    if (!selectedId) return
    setWorkflow((current) => deleteWorkflowSteps(current, [selectedId]))
    setSelectedId(null)
    setRun(undefined)
    setNotice('ノードを削除しました。後続ノードの入力は未接続として保持されます。')
  }

  function duplicateSelected() {
    if (!selectedId) return
    const newId = `${selectedId.replace(/[^a-z0-9_-]/g, '').slice(0, 40)}-copy-${Date.now().toString(36)}`
    setWorkflow((current) => duplicateWorkflowStep(current, selectedId, newId)); setSelectedId(newId); setRun(undefined)
    setNotice('ノードを複製しました。接続と設定を確認して保存してください。')
  }

  async function chooseWorkflow(id: string): Promise<boolean> {
    if (id === workflow.id) return true
    if (workflowDirty && !window.confirm('未保存の変更があります。破棄して別のWorkflowを開きますか？')) return false
    const selected = workflowLibrary.find((item) => item.workflow.id === id)
    if (!selected) return false
    const loaded = await loadWorkflowVersions(id)
    const latest = loaded.versions[0]
    if (!latest) return false
    setWorkflowVersions(loaded.versions); dispatchWorkflow({ type: 'reset', workflow: latest.workflow }); setRun(undefined); setSelectedId(null)
    setSavedWorkflow(latest)
    return true
  }

  function chooseWorkflowVersion(version: number) {
    const selected = workflowVersions.find((item) => item.version === version)
    if (!selected) return
    dispatchWorkflow({ type: 'reset', workflow: selected.workflow }); setSavedWorkflow(selected); setRun(undefined); setSelectedId(null)
  }

  function createWorkflow() {
    const next: Workflow = { version: 1, id: `wf_${crypto.randomUUID().replaceAll('-', '')}`, name: '名称未設定のWorkflow',
      description: '', steps: [{ id: 'source-1', kind: 'query', title: 'データソースから取得', config: { source: 'unconfigured', parameters: {} } }] }
    dispatchWorkflow({ type: 'reset', workflow: next }); setSavedWorkflow(undefined); setWorkflowVersions([]); setRun(undefined); setSelectedId('source-1')
  }

  async function removeWorkflow(item: WorkflowListItem) {
    if (!auth) throw new Error('ログインが必要です。')
    await archiveWorkflow(auth, item.workflow.id, item.version)
    const remaining = workflowLibrary.filter((candidate) => candidate.workflow.id !== item.workflow.id)
    setWorkflowLibrary(remaining)
    if (workflow.id === item.workflow.id) {
      const next = remaining[0]
      if (next) {
        const loaded = await loadWorkflowVersions(next.workflow.id)
        const latest = loaded.versions[0]
        if (!latest) throw new Error('次のWorkflowを読み込めませんでした。')
        setWorkflowVersions(loaded.versions); setSavedWorkflow(latest)
        dispatchWorkflow({ type: 'reset', workflow: latest.workflow })
      } else {
        createWorkflow()
      }
      setRun(undefined); setSelectedId(null); setSelectedEdgeId(null)
    }
    setNotice(`「${item.workflow.name}」を削除しました。過去のバージョンと実行履歴は保持されます。`)
  }

  async function openConversation(id: string) {
    const conversation = await loadConversation(id)
    setConversationId(conversation.id)
    setProposal(undefined)
    setMessages(conversation.messages.map((message) => ({ id: message.id,
      role: message.role === 'assistant' ? 'agent' : message.role,
      text: message.content,
      metadata: message.role === 'assistant' && message.metadata && typeof message.metadata === 'object'
        && 'state' in message.metadata ? message.metadata as ChatViewMessage['metadata'] : undefined })))
  }

  function newConversation() {
    setConversationId(undefined)
    setMessages([])
    setProposal(undefined)
    setPrompt('')
  }

  function openWorkflowView() {
    if (proposal) dispatchWorkflow({ type: 'edit', update: proposal.workflow })
    setChatOpen(false)
  }

  if (auth === undefined) return <main className="auth-screen"><LoaderCircle className="spin" /><span>セッションを確認しています</span></main>
  if (!auth) return <LoginView providers={providers} error={loginError} />

  return (
    <main className={`app-shell ${chatOpen ? 'chat-mode' : 'chat-closed'}`}>
      <aside className="sidebar">
        <div className="brand-mark"><Layers3 size={20} /><span>Multi Metric Mixer</span></div>
        <nav>
          <button className={`nav-button ${chatOpen ? 'active' : ''}`} onClick={() => setChatOpen(true)}><MessageSquareText size={19} /><span>分析チャット</span></button>
          <button className={`nav-button ${!chatOpen ? 'active' : ''}`} onClick={() => setChatOpen(false)}><WorkflowIcon size={19} /><span>ノードエディタ</span></button>
          <button className={`nav-button ${workflowManagerOpen ? 'active' : ''}`} onClick={() => setWorkflowManagerOpen(true)}><WorkflowIcon size={19} /><span>ワークフロー管理</span></button>
          {auth.applicationRole === 'admin' && <button className={`nav-button ${connectionOpen ? 'active' : ''}`} onClick={() => setConnectionOpen(true)}><Database size={19} /><span>データソース管理</span></button>}
          <button className={`nav-button ${catalogOpen ? 'active' : ''}`} onClick={() => setCatalogOpen(true)}><BookOpenCheck size={19} /><span>Data Catalog</span></button>
          <button className={`nav-button ${operationsOpen ? 'active' : ''}`} onClick={() => setOperationsOpen(true)}><Braces size={19} /><span>実行と成果物</span></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-user"><span className="avatar">{auth.principal.displayName.slice(0, 2).toUpperCase()}</span><span><strong>{auth.principal.displayName}</strong><small>{auth.workspace.name}</small></span></div>
          <button className="nav-button" onClick={logout}><LogOut size={17} /><span>ログアウト</span></button>
        </div>
      </aside>

      {chatOpen && <ChatWorkspace provider={agentProvider} workflow={workflow} dataSources={dataSources}
        conversations={conversations} conversationId={conversationId} messages={messages} proposal={proposal} run={run}
        planning={planning} executing={executing} prompt={prompt} onPromptChange={setPrompt} onSend={(message) => void sendPrompt(message)}
        onNewConversation={newConversation} onOpenConversation={(id) => void openConversation(id)} onOpenWorkflow={openWorkflowView}
        onRunWorkflow={() => void execute()}
        onApplyProposal={() => void applyProposal()} onDiscardProposal={() => setProposal(undefined)} />}

      {!chatOpen && <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>WORKFLOWS</span><ChevronRight size={13} /><select aria-label="保存済みWorkflow" value={workflow.id} onChange={(event) => void chooseWorkflow(event.target.value)}>
            {!workflowLibrary.some((item) => item.workflow.id === workflow.id) && <option value={workflow.id}>{workflow.name}</option>}
            {workflowLibrary.map((item) => <option value={item.workflow.id} key={item.workflow.id}>{item.workflow.name}</option>)}</select>
            {savedWorkflow && workflowVersions.length > 0 && <select aria-label="Workflow version" value={savedWorkflow.version} onChange={(event) => chooseWorkflowVersion(Number(event.target.value))}>
              {workflowVersions.map((item) => <option value={item.version} key={item.version}>v{item.version}{item.version === workflowVersions[0]?.version ? '（最新）' : ''}</option>)}</select>}
            <button className="toolbar-button new-workflow-button" onClick={createWorkflow}><Plus size={16} /><span>新規Workflow</span></button></div>
          <div className="top-actions">
            <span className="mcp-pill" title="MCPはBFFからインスタンス内部だけで利用されます"><span /> INTERNAL MCP · READ ONLY</span>
            <div className="history-actions">
              <button className="toolbar-button" title="元に戻す (⌘Z)" disabled={workflowHistory.past.length === 0} onClick={() => { dispatchWorkflow({ type: 'undo' }); setRun(undefined) }}><Undo2 size={16} /><span>元に戻す</span></button>
              <button className="toolbar-button" title="やり直す (⇧⌘Z)" disabled={workflowHistory.future.length === 0} onClick={() => { dispatchWorkflow({ type: 'redo' }); setRun(undefined) }}><Redo2 size={16} /><span>やり直す</span></button>
            </div>
            {!chatOpen && <button className="toolbar-button" onClick={() => setChatOpen(true)}><MessageSquareText size={16} /><span>分析チャットに戻る</span></button>}
            <WorkflowTransferActions auth={auth} saved={savedWorkflow} onImported={(saved) => {
              setSavedWorkflow(saved); dispatchWorkflow({ type: 'reset', workflow: saved.workflow }); setRun(undefined)
              setWorkflowVersions([saved])
              setWorkflowLibrary((items) => [{ workflow: saved.workflow, version: saved.version, status: saved.status, updatedAt: saved.updatedAt }, ...items])
            }} />
            <button className="save-button" onClick={() => void saveFromToolbar()} disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {savedWorkflow && workflowsEqual(savedWorkflow.workflow, workflow) ? `保存済み v${savedWorkflow.version}` : '保存'}
            </button>
            <button className="run-button" onClick={execute} disabled={executing}>
              {executing ? <LoaderCircle className="spin" size={16} /> : <Play size={15} fill="currentColor" />} 実行
            </button>
          </div>
        </header>

        <div className="canvas-wrap">
          <div className="canvas-heading">
            <div><span className="kicker">LIVE WORKFLOW</span><input className="workflow-name-input" aria-label="Workflow名" value={workflow.name} onChange={(event) => setWorkflow((current) => ({ ...current, name: event.target.value }))} /><input className="workflow-description-input" aria-label="Workflowの説明" placeholder="このWorkflowの目的" value={workflow.description} onChange={(event) => setWorkflow((current) => ({ ...current, description: event.target.value }))} /></div>
            <div className="step-count"><strong>{workflow.steps.length}</strong><span>STEPS</span></div>
          </div>
          {dataSources.length === 0 && (auth.applicationRole === 'admin' ? <button className="connection-callout" onClick={() => setConnectionOpen(true)}>
            <span><Database size={17} /></span><div><strong>データソースが未登録です</strong><small>管理画面から接続とスキーマを登録してください</small></div><ChevronRight size={16} />
          </button> : <div className="connection-callout" role="status">
            <span><Database size={17} /></span><div><strong>利用可能なデータソースがありません</strong><small>管理者へ登録を依頼してください</small></div>
          </div>)}
          <div className="flow-surface">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodesDelete={onNodesDelete}
              onBeforeDelete={onBeforeDelete}
              onEdgesDelete={onEdgesDelete}
              onConnect={onConnect}
              onReconnect={onReconnect}
              edgesReconnectable
              deleteKeyCode={['Backspace', 'Delete']}
              onNodeClick={(_, node) => selectNode(node)}
              onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedId(null) }}
              onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null) }}
              fitView
              fitViewOptions={{ padding: 0.22 }}
              minZoom={0.55}
              maxZoom={1.6}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#353931" />
              <LabeledFlowControls />
              <MiniMap pannable zoomable nodeColor={(node) => kindMeta[(node.data as WorkflowNodeData).kind].color} />
            </ReactFlow>

            <div className="node-toolbar">
              <div className="node-toolbar-title"><Plus size={15} /><span>ノードを追加</span></div>
              <div className="node-toolbar-actions">
                <button className="primary" onClick={() => addStep('query')}><Database size={15} /><span>データ取得</span></button>
                <button onClick={() => addStep('filterSelect')}><ListFilter size={15} /><span>絞り込み・列選択</span></button>
                <button onClick={() => addStep('derive')}><Calculator size={15} /><span>計算列</span></button>
                <button onClick={() => addStep('join')}><GitMerge size={15} /><span>データ結合</span></button>
                <button onClick={() => addStep('aggregate')}><Sigma size={15} /><span>単一集計</span></button>
                <button onClick={() => addStep('joinAggregate')}><GitMerge size={15} /><span>複数データ集計</span></button>
                <button onClick={() => addStep('sortLimit')}><ArrowDownWideNarrow size={15} /><span>並べ替え・件数</span></button>
                <button onClick={() => addStep('preview')}><Table2 size={15} /><span>プレビュー</span></button>
                <button onClick={() => addStep('csv')}><FileDown size={15} /><span>CSV出力</span></button>
              </div>
            </div>

            {selectedEdge && <div className="edge-toolbar"><span>接続を選択中</span><button onClick={deleteSelectedEdge}><Link2Off size={14} /> 接続を削除</button><small>Deleteキーでも削除できます</small></div>}

            {selectedStep && (
              <aside className="inspector">
                <div className="inspector-head"><div><span>NODE SETTINGS</span><strong>{selectedStep.title}</strong></div><button className="panel-close-button" onClick={() => setSelectedId(null)}><X size={14} /><span>閉じる</span></button></div>
                <label>表示名<input value={selectedStep.title} onChange={(event) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id ? { ...step, title: event.target.value } : step) }))} /></label>
                {selectedStep.kind === 'query' && <>
                  <label>登録済み接続<select value={selectedStep.config.source} onChange={(e) => updateStepConfig('source', e.target.value)}><option value="unconfigured" disabled>接続を選択</option>{dataSources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select></label>
                  {auth.applicationRole === 'admin'
                    ? <button className="register-inline" onClick={() => setConnectionOpen(true)}><Database size={13} /> データソース管理</button>
                    : dataSources.length === 0 && <small className="source-admin-note">接続設定は管理者が行います。</small>}
                </>}
                {'input' in selectedStep && <label>入力ノード<select value={selectedStep.input ?? ''} onChange={(e) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && 'input' in step ? { ...step, input: e.target.value || null } : step) }))}><option value="">未接続</option>{availableInputs.map((step) => <option value={step.id} key={step.id}>{step.title}</option>)}</select></label>}
                {selectedStep.kind === 'filterSelect' && <>
                  <label>出力する列（カンマ区切り、空欄は全列）<input value={selectedStep.config.columns.join(', ')} onChange={(e) => updateStepConfig('columns', e.target.value.split(',').map((value) => value.trim()).filter(Boolean))} /></label>
                  <div className="filter-editor"><strong>絞り込み条件</strong>{selectedStep.config.filters.map((filter, index) => <div className="filter-row" key={index}>
                    <input aria-label={`条件${index + 1}の列`} list={`filter-fields-${selectedStep.id}`} value={filter.field} onChange={(e) => updateStepConfig('filters', selectedStep.config.filters.map((item, itemIndex) => itemIndex === index ? { ...item, field: e.target.value } : item))} />
                    <select aria-label={`条件${index + 1}の演算子`} value={filter.operator} onChange={(e) => updateStepConfig('filters', selectedStep.config.filters.map((item, itemIndex) => itemIndex === index ? { ...item, operator: e.target.value } : item))}>
                      <option value="eq">等しい</option><option value="ne">等しくない</option><option value="gt">より大きい</option><option value="gte">以上</option><option value="lt">より小さい</option><option value="lte">以下</option><option value="contains">含む</option><option value="isNull">空である</option><option value="isNotNull">空でない</option>
                    </select>
                    {!['isNull', 'isNotNull'].includes(filter.operator) && <input aria-label={`条件${index + 1}の値`} value={filter.value === null ? '' : String(filter.value)} onChange={(e) => updateStepConfig('filters', selectedStep.config.filters.map((item, itemIndex) => itemIndex === index ? { ...item, value: e.target.value } : item))} />}
                    <button type="button" aria-label={`条件${index + 1}を削除`} onClick={() => updateStepConfig('filters', selectedStep.config.filters.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /> 削除</button>
                  </div>)}
                  <datalist id={`filter-fields-${selectedStep.id}`}>{selectedInputFields.map((field) => <option value={field.path} key={field.path} />)}</datalist>
                  <button type="button" className="register-inline" onClick={() => updateStepConfig('filters', [...selectedStep.config.filters, { field: selectedInputFields[0]?.path ?? 'field', operator: 'eq', value: '' }])}><Plus size={13} /> 条件を追加</button></div>
                </>}
                {selectedStep.kind === 'derive' && <>
                  <label>新しい列名<input value={selectedStep.config.output} onChange={(e) => updateStepConfig('output', e.target.value)} /></label>
                  <CatalogFieldSelect label="元の列" value={selectedStep.config.source} fields={selectedInputFields} onChange={(value) => updateStepConfig('source', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>計算<select value={selectedStep.config.operation} onChange={(e) => updateStepConfig('operation', e.target.value)}><option value="toNumber">数値へ変換</option><option value="toString">文字列へ変換</option><option value="year">年を抽出</option><option value="month">月を抽出</option><option value="add">加算</option><option value="subtract">減算</option><option value="multiply">乗算</option><option value="divide">除算</option></select></label>
                  {['add', 'subtract', 'multiply', 'divide'].includes(selectedStep.config.operation) && <><CatalogFieldSelect label="右辺の列（定数を使う場合は空欄）" value={selectedStep.config.operandField ?? ''} fields={selectedInputFields} numeric onChange={(value) => updateStepConfig('operandField', value || null)} onOpenCatalog={() => setCatalogOpen(true)} /><label>右辺の定数<input type="number" value={selectedStep.config.operandValue ?? ''} onChange={(e) => updateStepConfig('operandValue', e.target.value === '' ? null : Number(e.target.value))} /></label></>}
                </>}
                {selectedStep.kind === 'aggregate' && <>
                  <CatalogFieldSelect label="グループ列" value={selectedStep.config.groupBy} fields={aggregateFields} onChange={(value) => updateStepConfig('groupBy', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <CatalogFieldSelect label="数値列" value={selectedStep.config.metric} fields={aggregateFields} numeric onChange={(value) => updateStepConfig('metric', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>計算<select value={selectedStep.config.operation} onChange={(e) => updateStepConfig('operation', e.target.value)}><option value="sum">合計</option><option value="average">平均</option><option value="count">件数</option><option value="min">最小</option><option value="max">最大</option></select></label>
                </>}
                {selectedStep.kind === 'join' && <>
                  <label>左入力<select value={selectedStep.inputs.left ?? ''} onChange={(e) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && step.kind === 'join' ? { ...step, inputs: { ...step.inputs, left: e.target.value || null } } : step) }))}><option value="">未接続</option>{availableInputs.map((step) => <option value={step.id} key={step.id}>{step.title}</option>)}</select></label>
                  <CatalogFieldSelect label="左の結合列" value={selectedStep.config.leftKey} fields={leftJoinFields} onChange={(value) => updateStepConfig('leftKey', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>右入力<select value={selectedStep.inputs.right ?? ''} onChange={(e) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && step.kind === 'join' ? { ...step, inputs: { ...step.inputs, right: e.target.value || null } } : step) }))}><option value="">未接続</option>{availableInputs.map((step) => <option value={step.id} key={step.id}>{step.title}</option>)}</select></label>
                  <CatalogFieldSelect label="右の結合列" value={selectedStep.config.rightKey} fields={rightJoinFields} onChange={(value) => updateStepConfig('rightKey', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>結合方式<select value={selectedStep.config.joinType} onChange={(e) => updateStepConfig('joinType', e.target.value)}><option value="inner">内部結合（両方にある行）</option><option value="left">左結合（左の全行）</option></select></label>
                </>}
                {selectedStep.kind === 'joinAggregate' && <>
                  <label>左入力<select value={selectedStep.inputs.left ?? ''} onChange={(e) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && step.kind === 'joinAggregate' ? { ...step, inputs: { ...step.inputs, left: e.target.value || null } } : step) }))}><option value="">未接続</option>{availableInputs.map((step) => <option value={step.id} key={step.id}>{step.title}</option>)}</select></label>
                  <CatalogFieldSelect label="左の結合列" value={selectedStep.config.leftKey} fields={leftJoinFields} onChange={(value) => updateStepConfig('leftKey', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <CatalogFieldSelect label="左の数値列" value={selectedStep.config.metric} fields={leftJoinFields} numeric onChange={(value) => updateStepConfig('metric', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>右入力<select value={selectedStep.inputs.right ?? ''} onChange={(e) => setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && step.kind === 'joinAggregate' ? { ...step, inputs: { ...step.inputs, right: e.target.value || null } } : step) }))}><option value="">未接続</option>{availableInputs.map((step) => <option value={step.id} key={step.id}>{step.title}</option>)}</select></label>
                  <CatalogFieldSelect label="右の結合列" value={selectedStep.config.rightKey} fields={rightJoinFields} onChange={(value) => updateStepConfig('rightKey', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <CatalogFieldSelect label="右のグループ列" value={selectedStep.config.groupBy} fields={rightJoinFields} onChange={(value) => updateStepConfig('groupBy', value)} onOpenCatalog={() => setCatalogOpen(true)} />
                  <label>計算<select value={selectedStep.config.operation} onChange={(e) => updateStepConfig('operation', e.target.value)}><option value="sum">合計</option><option value="average">平均</option></select></label>
                </>}
                {selectedStep.kind === 'sortLimit' && <><CatalogFieldSelect label="並べ替える列" value={selectedStep.config.sortBy} fields={selectedInputFields} onChange={(value) => updateStepConfig('sortBy', value)} onOpenCatalog={() => setCatalogOpen(true)} /><label>順序<select value={selectedStep.config.direction} onChange={(e) => updateStepConfig('direction', e.target.value)}><option value="asc">昇順</option><option value="desc">降順</option></select></label><label>最大件数<input type="number" min="1" max="5000" value={selectedStep.config.limit} onChange={(e) => updateStepConfig('limit', Number(e.target.value))} /></label></>}
                {selectedStep.kind === 'preview' && <label>表示件数<input type="number" min="1" max="100" value={selectedStep.config.limit} onChange={(e) => updateStepConfig('limit', Number(e.target.value))} /></label>}
                {selectedStep.kind === 'csv' && <><label>ファイル名<input value={selectedStep.config.fileName} onChange={(e) => updateStepConfig('fileName', e.target.value)} /></label><label>CSVの安全モード<select value={selectedStep.config.mode} onChange={(e) => updateStepConfig('mode', e.target.value)}><option value="spreadsheet">表計算向け（数式を無効化）</option><option value="machine">システム連携向け</option></select></label></>}
                <div className="inspector-meta"><span>STEP ID</span><code>{selectedStep.id}</code></div>
                <button className="duplicate-button" onClick={duplicateSelected}><Plus size={14} /> ノードを複製</button>
                <button className="delete-button" onClick={removeSelected}><Trash2 size={14} /> ノードを削除</button>
              </aside>
            )}
          </div>

          {(notice || resultArtifact) && (
            <section className="result-drawer">
              <div className="result-title">
                <div><span className="result-check"><Check size={16} /></span><div><strong>実行結果</strong><small>{notice}</small></div></div>
                {csvArtifact && <ArtifactDownloadButton auth={auth} artifact={csvArtifact} />}
              </div>
              {resultArtifact?.preview && resultArtifact.preview.length > 0 && (
                <div className="table-scroll"><table><thead><tr>{resultArtifact.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{resultArtifact.preview.map((row, index) => <tr key={index}>{resultArtifact.columns.map((column) => { const value = row[column]; return <td key={column}><code className="json-cell">{typeof value === 'number' ? value.toLocaleString('ja-JP') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</code></td> })}</tr>)}</tbody></table></div>
              )}
            </section>
          )}
        </div>
      </section>}

      {connectionOpen && auth.applicationRole === 'admin' && <ConnectionManager auth={auth} sources={dataSources} onChange={(next) => {
        const added = next.find((source) => !dataSources.some((current) => current.id === source.id))
        setDataSources(next)
        if (added && selectedStep?.kind === 'query' && selectedStep.config.source === 'unconfigured') updateStepConfig('source', added.id)
      }} onDeleted={(id) => {
        setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.kind === 'query' && step.config.source === id
          ? { ...step, config: { ...step.config, source: 'unconfigured' } } : step) }))
        setRun(undefined)
      }} onClose={() => setConnectionOpen(false)} />}
      {catalogOpen && <Suspense fallback={<div className="modal-backdrop"><div className="catalog-loading"><LoaderCircle className="spin" />Data Catalogを読み込んでいます</div></div>}>
        <CatalogManager auth={auth} sources={dataSources} onChange={async () => setCatalogs((await loadCatalogs(auth)).catalogs)} onClose={() => setCatalogOpen(false)} />
      </Suspense>}
      {workflowManagerOpen && <WorkflowManager auth={auth} workflows={workflowLibrary} activeWorkflowId={workflow.id} activeDirty={workflowDirty}
        onOpen={async (id) => { if (await chooseWorkflow(id)) setWorkflowManagerOpen(false) }}
        onCreate={() => { createWorkflow(); setWorkflowManagerOpen(false) }} onDelete={removeWorkflow} onClose={() => setWorkflowManagerOpen(false)} />}
      {runApproval && <div className="modal-backdrop"><section className="approval-modal" role="dialog" aria-modal="true" aria-label="CSV出力を含む実行の確認">
        <header><div><span>RUN APPROVAL</span><h2>CSV出力を含むWorkflowを実行しますか？</h2></div><button className="panel-close-button" onClick={() => setRunApproval(undefined)}><X size={14} /><span>閉じる</span></button></header>
        <ApprovalSummary summary={runApproval.summary} />
        <p>表示された保存済みバージョンだけを一度実行できます。CSVはWorkspace内の暗号化された成果物保管領域に保存され、外部には送信されません。</p>
        <footer><button onClick={() => setRunApproval(undefined)}>キャンセル</button><button className="primary" disabled={executing} onClick={() => void confirmRunExport()}>{executing ? '実行中…' : '確認して実行'}</button></footer>
      </section></div>}
      {operationsOpen && <OperationsPanel auth={auth} workflows={workflowLibrary} onClose={() => setOperationsOpen(false)} />}
    </main>
  )
}
