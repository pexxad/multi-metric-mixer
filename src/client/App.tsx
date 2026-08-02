import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type NodeChange,
} from '@xyflow/react'
import {
  Braces,
  BookOpenCheck,
  Calculator,
  Check,
  ChevronRight,
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
  Undo2,
  Workflow as WorkflowIcon,
  X,
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
  ApiProblemError,
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
import type { CatalogVersion } from '../shared/catalog'
import { LoginView } from './LoginView'
import { ConnectionManager } from './ConnectionManager'
import type { AgentGenerationActivity, AgentResponse, AgentToolActivity } from '../shared/api'
import { WorkflowTransferActions } from './WorkflowTransferActions'
import { OperationsPanel } from './OperationsPanel'
import { ArtifactDownloadButton } from './ArtifactDownloadButton'
import { WorkflowManager } from './WorkflowManager'
import { ApprovalSummary } from './ApprovalSummary'
import { ChatWorkspace, type ChatViewMessage } from './ChatWorkspace'
import { NodeInspector } from './NodeInspector'
import {
  connectNodes,
  createWorkflowStepId,
  disconnectEdge,
  duplicateWorkflowStep,
  fieldsForStep,
  instantiateWorkflowTemplate,
  outputDataModel,
  requiredInputDataModel,
  sourceIdsForStep,
  workflowHistoryReducer,
  workflowsEqual,
} from './workflow-editor'
import {
  LabeledFlowControls,
  workflowNodeMeta,
  workflowNodeTypes,
  workflowToEdges,
  workflowToNodes,
  type FlowNode,
  type WorkflowNodeData,
} from './workflow-graph'

const CatalogManager = lazy(() => import('./CatalogManager').then((module) => ({ default: module.CatalogManager })))

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
  const [activeToolCalls, setActiveToolCalls] = useState<AgentToolActivity[]>([])
  const [activeGenerations, setActiveGenerations] = useState<AgentGenerationActivity[]>([])
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
    ? workflow.steps.slice(0, workflow.steps.findIndex((step) => step.id === selectedStep.id)).filter((step) => {
      const actual = outputDataModel(workflow, dataSources, step.id)
      const required = requiredInputDataModel(selectedStep.kind)
      return step.kind !== 'csv' && (required === 'any' || required === actual)
    })
    : []
  const selectedInputFields = selectedStep && 'input' in selectedStep ? fieldsForStep(workflow, catalogs, dataSources, selectedStep.input) : []
  const aggregateFields = selectedStep?.kind === 'aggregate' ? fieldsForStep(workflow, catalogs, dataSources, selectedStep.input) : []
  const leftJoinFields = selectedStep && (selectedStep.kind === 'joinAggregate' || selectedStep.kind === 'join') ? fieldsForStep(workflow, catalogs, dataSources, selectedStep.inputs.left) : []
  const rightJoinFields = selectedStep && (selectedStep.kind === 'joinAggregate' || selectedStep.kind === 'join') ? fieldsForStep(workflow, catalogs, dataSources, selectedStep.inputs.right) : []
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
    setActiveToolCalls([])
    setActiveGenerations([])
    const toolCalls = new Map<string, AgentToolActivity>()
    const generations = new Map<string, AgentGenerationActivity>()
    const clientMessageId = crypto.randomUUID()
    setMessages((items) => [...items, { id: `local-user-${clientMessageId}`, role: 'user', text: trimmed }])
    try {
      if (!auth) throw new Error('ログインが必要です。')
      const result = await respondToAgent(auth, { message: trimmed, workflow, conversationId, clientMessageId }, (activity) => {
        if ('generatedTokens' in activity) {
          generations.set(activity.id, activity)
          setActiveGenerations([...generations.values()])
          return
        }
        toolCalls.set(activity.id, activity)
        setActiveToolCalls([...toolCalls.values()])
      })
      setCatalogs((await loadCatalogs()).catalogs)
      const { conversationId: nextConversationId, ...metadata } = result
      setConversationId(nextConversationId)
      setMessages((items) => [...items, {
        id: `local-agent-${clientMessageId}`,
        role: 'agent',
        text: result.message,
        metadata,
        toolCalls: result.toolCalls,
        generations: [...generations.values()],
      }])
      if (result.state === 'proposal') setProposal(result)
      setConversations((items) => [{ id: nextConversationId, title: items.find((item) => item.id === nextConversationId)?.title ?? trimmed.slice(0, 80),
        workflowId: items.find((item) => item.id === nextConversationId)?.workflowId ?? null, updatedAt: new Date().toISOString() },
      ...items.filter((item) => item.id !== nextConversationId)])
    } catch (error) {
      setMessages((items) => [...items, {
        id: `local-error-${clientMessageId}`,
        role: 'system',
        text: error instanceof Error ? error.message : String(error),
        toolCalls: [...toolCalls.values()],
        generations: [...generations.values()],
        diagnostic: error instanceof ApiProblemError ? {
          code: error.problem.code,
          requestId: error.problem.requestId,
          details: error.problem.errors,
        } : undefined,
      }])
    } finally {
      setPlanning(false)
      setActiveToolCalls([])
      setActiveGenerations([])
    }
  }

  async function runSavedWorkflow(saved: SavedWorkflow) {
    if (!auth) throw new Error('ログインが必要です。')
    if (saved.workflow.steps.some((step) => step.kind === 'csv')) {
      const approval = await requestWorkflowRunApproval(auth, saved.workflow.id, saved.version)
      setRunApproval({ ...approval, saved })
      return
    }
    const result = await executeWorkflow(auth, saved.workflow.id, saved.version, undefined, conversationId)
    setRun(result.run)
    setMessages((items) => [...items, {
      id: `workflow-run-${result.run.id}`,
      role: 'system',
      text: `「${saved.workflow.name}」を実行しました。`,
      run: result.run,
    }])
    setNotice(`${result.run.steps.length}ステップを ${result.run.durationMs}ms で実行しました。`)
  }

  async function applyProposal(runAfterApply = false) {
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
      if (runAfterApply) await runSavedWorkflow(saved)
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
      await runSavedWorkflow(saved)
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
      const result = await executeWorkflow(auth, pending.saved.workflow.id, pending.saved.version, pending.id, conversationId)
      setRun(result.run); setRunApproval(undefined)
      setMessages((items) => [...items, {
        id: `workflow-run-${result.run.id}`,
        role: 'system',
        text: `「${pending.saved.workflow.name}」を実行しました。`,
        run: result.run,
      }])
      setNotice(`${result.run.steps.length}ステップを ${result.run.durationMs}ms で実行しました。`)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setExecuting(false) }
  }

  function addStep(kind: WorkflowStep['kind']) {
    const id = createWorkflowStepId(kind)
    if (kind === 'query') {
      const step: WorkflowStep = { id, kind, title: 'データソースから取得', config: { source: 'unconfigured', parameters: {}, template: null } }
      setWorkflow((current) => ({ ...current, steps: [...current.steps, step] }))
      setSelectedId(id)
      return
    }
    if (kind === 'joinAggregate' || kind === 'join') {
      const candidates = workflow.steps.filter((step) => outputDataModel(workflow, dataSources, step.id) === 'table')
      if (candidates.length < 2) { setNotice('結合には、先に2つ以上のデータ取得・変換ノードが必要です。'); return }
      const [left, right] = candidates.slice(-2)
      const leftFields = fieldsForStep(workflow, catalogs, dataSources, left.id)
      const rightFields = fieldsForStep(workflow, catalogs, dataSources, right.id)
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
    const required = requiredInputDataModel(kind)
    const input = [...workflow.steps].reverse().find((step) => {
      const actual = outputDataModel(workflow, dataSources, step.id)
      return step.kind !== 'csv' && (required === 'any' || required === actual)
    })?.id
    if (!input) {
      setNotice(kind === 'parseDocuments'
        ? '先にJSONライク形式を出力するデータ取得ノードを追加してください。'
        : 'このノードには表形式の入力が必要です。JSONライク形式は先に「表形式に変換」してください。')
      return
    }
    const inputFields = fieldsForStep(workflow, catalogs, dataSources, input)
    const firstField = inputFields[0]?.path ?? 'value'
    const numericField = inputFields.find((field) => field.dataTypes.includes('number'))?.path ?? firstField
    const step: WorkflowStep = kind === 'parseDocuments'
      ? { id, kind, title: 'JSONライク形式を表形式に変換', input, config: {
        recordPath: '$', columns: [{ name: 'value', path: '$.value', dataType: 'string' }],
        onMissing: 'null', onTypeMismatch: 'error',
      } }
      : kind === 'filterSelect'
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
      description: '', steps: [{ id: 'source-1', kind: 'query', title: 'データソースから取得', config: { source: 'unconfigured', parameters: {}, template: null } }] }
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
    setMessages(conversation.messages.map((message) => {
      const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
        ? message.metadata as Record<string, unknown> : undefined
      return {
        id: message.id,
        role: message.role === 'assistant' ? 'agent' as const : message.role,
        text: message.content,
        metadata: message.role === 'assistant' && metadata && 'state' in metadata
          ? metadata as ChatViewMessage['metadata'] : undefined,
        run: message.role === 'system' && metadata?.type === 'workflow_run' && metadata.run
          ? metadata.run as WorkflowRun : undefined,
      }
    }))
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

      {chatOpen && <ChatWorkspace workflow={workflow} dataSources={dataSources}
        conversations={conversations} conversationId={conversationId} messages={messages} proposal={proposal}
        planning={planning} activeToolCalls={activeToolCalls} activeGenerations={activeGenerations}
        executing={executing} prompt={prompt} onPromptChange={setPrompt} onSend={(message) => void sendPrompt(message)}
        onNewConversation={newConversation} onOpenConversation={(id) => void openConversation(id)} onOpenWorkflow={openWorkflowView}
        onRunWorkflow={() => void execute()}
        onApplyProposal={() => void applyProposal()} onApplyProposalAndRun={() => void applyProposal(true)}
        onDiscardProposal={() => setProposal(undefined)} />}

      {!chatOpen && <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>WORKFLOWS</span><ChevronRight size={13} /><select aria-label="保存済みWorkflow" value={workflow.id} onChange={(event) => void chooseWorkflow(event.target.value)}>
            {!workflowLibrary.some((item) => item.workflow.id === workflow.id) && <option value={workflow.id}>{workflow.name}</option>}
            {workflowLibrary.map((item) => <option value={item.workflow.id} key={item.workflow.id}>{item.workflow.name}</option>)}</select>
            {savedWorkflow && workflowVersions.length > 0 && <select aria-label="Workflow version" value={savedWorkflow.version} onChange={(event) => chooseWorkflowVersion(Number(event.target.value))}>
              {workflowVersions.map((item) => <option value={item.version} key={item.version}>v{item.version}{item.version === workflowVersions[0]?.version ? '（最新）' : ''}</option>)}</select>}
            <button className="toolbar-button new-workflow-button" onClick={createWorkflow}><Plus size={16} /><span>新規Workflow</span></button></div>
          <div className="top-actions">
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
              nodeTypes={workflowNodeTypes}
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
              <MiniMap pannable zoomable nodeColor={(node) => workflowNodeMeta[(node.data as WorkflowNodeData).kind].color} />
            </ReactFlow>

            <div className="node-toolbar">
              <div className="node-toolbar-title"><Plus size={15} /><span>ノードを追加</span></div>
              <div className="node-toolbar-actions">
                <button className="primary" onClick={() => addStep('query')}><Database size={15} /><span>データ取得</span></button>
                <button onClick={() => addStep('parseDocuments')}><Braces size={15} /><span>表形式に変換</span></button>
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

            {selectedStep ? <NodeInspector
              step={selectedStep}
              availableInputs={availableInputs}
              dataSources={dataSources}
              selectedInputFields={selectedInputFields}
              aggregateFields={aggregateFields}
              leftJoinFields={leftJoinFields}
              rightJoinFields={rightJoinFields}
              isAdmin={auth.applicationRole === 'admin'}
              onChange={(updated) => {
                setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === updated.id ? updated : step) }))
                setRun(undefined)
              }}
              onOpenCatalog={() => setCatalogOpen(true)}
              onOpenConnections={() => setConnectionOpen(true)}
              onClose={() => setSelectedId(null)}
              onDuplicate={duplicateSelected}
              onRemove={removeSelected}
            /> : null}
          </div>

          {(notice || resultArtifact) && (
            <section className="result-drawer">
              <div className="result-title">
                <div><span className="result-check"><Check size={16} /></span><div><strong>実行結果</strong><small>{notice}</small></div></div>
                {csvArtifact && <ArtifactDownloadButton auth={auth} artifact={csvArtifact} />}
              </div>
              {resultArtifact?.type === 'documents' && resultArtifact.preview && resultArtifact.preview.length > 0
                ? <div className="table-scroll"><pre className="json-cell">{JSON.stringify(resultArtifact.preview, null, 2)}</pre></div>
                : resultArtifact?.preview && resultArtifact.preview.length > 0 && (
                <div className="table-scroll"><table><thead><tr>{resultArtifact.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{resultArtifact.preview.map((row, index) => <tr key={index}>{resultArtifact.columns.map((column) => { const value = typeof row === 'object' && row !== null && !Array.isArray(row) ? row[column] : null; return <td key={column}><code className="json-cell">{typeof value === 'number' ? value.toLocaleString('ja-JP') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</code></td> })}</tr>)}</tbody></table></div>
              )}
            </section>
          )}
        </div>
      </section>}

      {connectionOpen && auth.applicationRole === 'admin' && <ConnectionManager auth={auth} onSaved={(source, isNew) => {
        setDataSources((items) => isNew ? [...items, source] : items.map((item) => item.id === source.id ? source : item))
        if (isNew && selectedStep?.kind === 'query' && selectedStep.config.source === 'unconfigured') {
          setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.id === selectedStep.id && step.kind === 'query'
            ? { ...step, config: { ...step.config, source: source.id } } : step) }))
          setRun(undefined)
        }
      }} onDeleted={(id) => {
        setDataSources((items) => items.filter((source) => source.id !== id))
        setWorkflow((current) => ({ ...current, steps: current.steps.map((step) => step.kind === 'query' && step.config.source === id
          ? { ...step, config: { ...step.config, source: 'unconfigured' } } : step) }))
        setRun(undefined)
      }} onClose={() => setConnectionOpen(false)} />}
      {catalogOpen && <Suspense fallback={<div className="modal-backdrop"><div className="catalog-loading"><LoaderCircle className="spin" />Data Catalogを読み込んでいます</div></div>}>
        <CatalogManager auth={auth} sources={dataSources} onChange={async () => setCatalogs((await loadCatalogs()).catalogs)} onClose={() => setCatalogOpen(false)} />
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
