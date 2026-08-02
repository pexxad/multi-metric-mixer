import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Bug,
  Database,
  GitBranch,
  Gauge,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Send,
  Sparkles,
  Table2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import type { AgentGenerationActivity, AgentResponse, AgentToolActivity, AgentWorkflowRun } from '../shared/api'
import type { ArtifactSummary, Workflow, WorkflowRun } from '../shared/workflow'
import type { DataSource } from './api'

type StoredAgentResponse<T> = T extends unknown ? Omit<T, 'conversationId'> : never
export type AgentMessageMetadata = StoredAgentResponse<AgentResponse>

export type ChatViewMessage = {
  id: string
  role: 'agent' | 'user' | 'system'
  text: string
  metadata?: AgentMessageMetadata
  toolCalls?: AgentToolActivity[]
  generations?: AgentGenerationActivity[]
  diagnostic?: { code?: string; requestId?: string; details?: unknown }
  run?: WorkflowRun
}

type ConversationSummary = { id: string; title: string; workflowId: string | null; updatedAt: string }

type ChatWorkspaceProps = {
  workflow: Workflow
  dataSources: DataSource[]
  conversations: ConversationSummary[]
  conversationId?: string
  messages: ChatViewMessage[]
  proposal?: Extract<AgentResponse, { state: 'proposal' }>
  planning: boolean
  activeToolCalls: AgentToolActivity[]
  activeGenerations: AgentGenerationActivity[]
  executing: boolean
  prompt: string
  onPromptChange: (value: string) => void
  onSend: (message?: string) => void
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
  onOpenWorkflow: () => void
  onRunWorkflow: () => void
  onApplyProposal: () => void
  onApplyProposalAndRun: () => void
  onDiscardProposal: () => void
}

const usageNotes = [
  '同じ依頼の中では取得済みのデータを使います。最新データが必要な場合は、新しい依頼として再取得してください。',
]

function UsageNotesDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="modal-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="usage-notes-modal" role="dialog" aria-modal="true" aria-labelledby="usage-notes-title">
      <header>
        <div>
          <span>GUIDE</span>
          <h2 id="usage-notes-title">仕様・注意事項</h2>
        </div>
        <button className="panel-close-button" onClick={onClose}><X size={14} /><span>閉じる</span></button>
      </header>
      <ul>{usageNotes.map((note) => <li key={note}>{note}</li>)}</ul>
    </section>
  </div>
}

function ToolActivityTimeline({ activities }: { activities: AgentToolActivity[] }) {
  if (activities.length === 0) return null
  return <section className="agent-tool-timeline" aria-label="MCPツール実行状況">
    <header><GitBranch size={13} /><strong>MCPツール実行状況</strong></header>
    <ol>{activities.map((activity) => <li key={activity.id} className={activity.status}>
      <span className="tool-activity-icon">
        {activity.status === 'running'
          ? <LoaderCircle className="spin" size={13} />
          : activity.status === 'completed'
            ? <Check size={13} />
            : <CircleAlert size={13} />}
      </span>
      <span><strong>{activity.label}</strong><code>{activity.tool}</code></span>
      <small>{activity.status === 'running'
        ? '実行中'
        : activity.status === 'completed'
          ? `${activity.durationMs ?? 0}msで完了`
          : '失敗'}</small>
    </li>)}</ol>
  </section>
}

function GenerationTimeline({ activities }: { activities: AgentGenerationActivity[] }) {
  if (activities.length === 0) return null
  return <section className="agent-generation-timeline" aria-label="モデル生成状況">
    <header><Gauge size={13} /><strong>モデル生成状況</strong></header>
    <ol>{activities.map((activity, index) => <li key={activity.id} className={activity.status}>
      <span>{activity.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}</span>
      <div><strong>生成 {index + 1}</strong><small>
        本文 {activity.contentCharacters.toLocaleString('ja-JP')}文字
        {activity.reasoningCharacters > 0 ? ` · 推論 ${activity.reasoningCharacters.toLocaleString('ja-JP')}文字` : ''}
      </small></div>
      <div><strong>{activity.tokenCount === 'estimated' ? '約' : ''}{activity.generatedTokens.toLocaleString('ja-JP')} tokens</strong>
        <small>{activity.status === 'running' ? '生成中' : `${activity.elapsedMs.toLocaleString('ja-JP')}ms`}</small></div>
    </li>)}</ol>
  </section>
}

function ErrorDiagnostics({ diagnostic }: { diagnostic?: ChatViewMessage['diagnostic'] }) {
  if (!diagnostic || (!diagnostic.code && !diagnostic.requestId && diagnostic.details === undefined)) return null
  return <details className="agent-error-diagnostics">
    <summary><Bug size={13} />エラー詳細を表示</summary>
    <pre>{JSON.stringify({
      ...(diagnostic.code ? { code: diagnostic.code } : {}),
      ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}),
      ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
    }, null, 2)}</pre>
    <p>hidden reasoning本文と認証情報は表示されません。</p>
  </details>
}

function ArtifactPreview({ artifact, label = '取得データ' }: { artifact: ArtifactSummary; label?: string }) {
  return <section className="chat-sample" aria-label={label}>
    <header><Table2 size={14} /><strong>{label}</strong><span>{artifact.rowCount}件</span></header>
    {artifact.type === 'documents'
      ? <div><pre>{JSON.stringify(artifact.preview ?? [], null, 2)}</pre></div>
      : <div><table><thead><tr>{artifact.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{(artifact.preview ?? []).map((row, index) => <tr key={index}>{artifact.columns.map((column) => {
          const value = typeof row === 'object' && row !== null && !Array.isArray(row) ? row[column] : null
          return <td key={column}>{value === null ? <em>null</em> : typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
        })}</tr>)}</tbody></table></div>}
    <footer>表示内容は信頼されない入力データとして扱われます。</footer>
  </section>
}

const ConversationList = memo(function ConversationList({ conversations, activeId, onOpen }: {
  conversations: ConversationSummary[]
  activeId?: string
  onOpen: (id: string) => void
}) {
  return <nav className="conversation-list" aria-label="過去の会話">
    {conversations.length === 0
      ? <p className="conversation-empty">保存された会話はまだありません。</p>
      : conversations.map((conversation) => <button key={conversation.id} className={conversation.id === activeId ? 'active' : ''}
        onClick={() => onOpen(conversation.id)}>
        <span>{conversation.title}</span>
        <small><Clock3 size={11} />{new Date(conversation.updatedAt).toLocaleString('ja-JP')}</small>
      </button>)}
  </nav>
})

function WorkflowRunResult({ run, onOpenWorkflow }: {
  run: WorkflowRun | AgentWorkflowRun
  onOpenWorkflow: () => void
}) {
  return <section className="chat-run-card" aria-label="Workflow実行結果">
    <header><div><Check size={16} /><span>WORKFLOW RUN</span></div><strong>Workflowの実行が完了しました</strong>
      <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString('ja-JP')}</time></header>
    <div className="chat-run-metrics">
      <span><strong>{run.finalArtifact.rowCount.toLocaleString('ja-JP')}</strong>行</span>
      <span><strong>{run.finalArtifact.columns.length}</strong>列</span>
      <span><strong>{run.durationMs.toLocaleString('ja-JP')}</strong>ms</span>
    </div>
    <p><Table2 size={14} /><strong>{run.finalArtifact.name}</strong><span>{run.finalArtifact.columns.slice(0, 5).join('、')}</span></p>
    {run.finalArtifact.type === 'table' && (run.finalArtifact.preview?.length ?? 0) > 0
      ? <div className="chat-run-preview"><table><thead><tr>{run.finalArtifact.columns.map((column) =>
        <th key={column}>{column}</th>)}</tr></thead><tbody>{run.finalArtifact.preview!.map((row, index) =>
          <tr key={index}>{run.finalArtifact.columns.map((column) => {
            const value = typeof row === 'object' && row !== null && !Array.isArray(row) ? row[column] : null
            return <td key={column}>{value === null ? <em>null</em> : typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
          })}</tr>)}</tbody></table></div>
      : null}
    <footer><span>入力データは信頼されないデータとして処理されました。</span>
      <button onClick={onOpenWorkflow}>結果の詳細を確認</button></footer>
  </section>
}

function AgentMessage({ message, onSend, onOpenWorkflow }: {
  message: ChatViewMessage
  onSend: (message?: string) => void
  onOpenWorkflow: () => void
}) {
  const metadata = message.metadata
  const workflowRun = message.run ?? (metadata?.state === 'answer' ? metadata.workflowRun : undefined)
  return <article className={`chat-message-card ${message.role}`}>
    <span className="chat-message-avatar">{message.role === 'agent' ? <Sparkles size={15} /> : message.role === 'user' ? 'YOU' : <Bot size={15} />}</span>
    <div>
      <header><strong>{message.role === 'agent' ? 'Mixer Agent' : message.role === 'user' ? 'あなた' : 'システム'}</strong></header>
      <p>{message.text}</p>
      <GenerationTimeline activities={message.generations ?? []} />
      <ToolActivityTimeline activities={message.toolCalls ?? metadata?.toolCalls ?? []} />
      <ErrorDiagnostics diagnostic={message.diagnostic} />
      {metadata?.state === 'answer' && metadata.catalogs.map((catalog) => <section
        className="chat-catalog" aria-label={`${catalog.displayName}のData Catalog`} key={`${catalog.sourceId}:${catalog.scope}:${catalog.version}`}>
        <header>
          <Database size={14} />
          <div><strong>{catalog.displayName}</strong><span>{catalog.sourceId}</span></div>
          <span>{catalog.dataModel === 'table' ? '表形式' : 'JSONライク形式'} · {catalog.scope === 'personal' ? '個人版' : '正本'} v{catalog.version}</span>
        </header>
        {catalog.description ? <p>{catalog.description}</p> : null}
        <div><table>
          <thead><tr><th>項目</th><th>型</th><th>業務名</th><th>説明</th><th>出現率</th></tr></thead>
          <tbody>{catalog.fields.map((field) => <tr key={field.path}>
            <td><code>{field.path}</code></td>
            <td>{[...new Set([...field.dataTypes, ...(field.nullable ? ['null' as const] : [])])].join(' / ')}</td>
            <td>{field.businessName || '—'}</td>
            <td>{field.description || '—'}</td>
            <td>{Math.round(field.presence * 100)}%</td>
          </tr>)}</tbody>
        </table></div>
        <footer>{catalog.fields.length}項目 · MCPから取得した構造化Catalog</footer>
      </section>)}
      {workflowRun ? <WorkflowRunResult run={workflowRun} onOpenWorkflow={onOpenWorkflow} /> : null}
      {metadata?.state === 'answer' && (metadata.artifacts ?? [])
        .filter((artifact) => artifact.id !== workflowRun?.finalArtifact.id).map((artifact) =>
        <ArtifactPreview artifact={artifact} key={artifact.id} />)}
      {metadata?.state === 'clarification' && <div className="clarification-list">
        {metadata.questions.map((question) => <section key={question.id}>
          <strong>{question.prompt}</strong>
          {question.choices.length > 0 && <div>{question.choices.map((choice) => <button key={choice} onClick={() => onSend(choice)}>{choice}</button>)}</div>}
        </section>)}
      </div>}
    </div>
  </article>
}

export function ChatWorkspace(props: ChatWorkspaceProps) {
  const messagesEnd = useRef<HTMLDivElement>(null)
  const [usageNotesOpen, setUsageNotesOpen] = useState(false)
  const suggestions = useMemo(() => {
    const sourceNames = props.dataSources.slice(0, 2).map((source) => source.name)
    if (sourceNames.length === 0) return ['利用できるデータを教えてください', '新しい分析計画を作りたい']
    return [
      `${sourceNames[0]}の内容と利用できる項目を教えてください`,
      sourceNames[1] ? `${sourceNames[0]}と${sourceNames[1]}を使った分析を考えてください` : `${sourceNames[0]}を集計してプレビューしたい`,
    ]
  }, [props.dataSources])

  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'end' }) }, [props.messages.length, props.planning, props.proposal])

  return <section className="chat-workspace" aria-label="分析チャット">
    <aside className="conversation-rail">
      <div className="conversation-rail-head">
        <span>CONVERSATIONS</span>
        <button onClick={props.onNewConversation}><MessageSquarePlus size={14} /><span>新しい会話</span></button>
      </div>
      <ConversationList conversations={props.conversations} activeId={props.conversationId} onOpen={props.onOpenConversation} />
    </aside>

    <div className="chat-main">
      <header className="chat-workspace-header">
        <div><span className="agent-avatar"><Sparkles size={17} /></span><div><strong>Mixer Agent</strong></div></div>
        <div className="chat-header-actions">
          <button className="toolbar-button" onClick={() => setUsageNotesOpen(true)}><CircleAlert size={15} /><span>仕様・注意事項</span></button>
          <button className="toolbar-button" onClick={props.onOpenWorkflow}><WorkflowIcon size={15} /><span>ノードで詳細を開く</span></button>
        </div>
      </header>

      <div className="chat-scroll-region" aria-live="polite">
        {props.messages.length === 0 ? <section className="chat-welcome">
          <span><Sparkles size={24} /></span>
          <p className="eyebrow">AI-ASSISTED ANALYSIS</p>
          <h1>何を知りたいですか？</h1>
          <p>目的を業務用語で入力してください。利用可能なデータを確認し、必要な質問をしたうえで、実行前に分析計画を提示します。</p>
          <div className="chat-source-summary"><Database size={15} /><strong>{props.dataSources.length}件のデータソース</strong>
            <span>{props.dataSources.length > 0 ? props.dataSources.slice(0, 3).map((source) => source.name).join('、') : '管理者による登録を待っています'}</span></div>
        </section> : props.messages.map((message) => <AgentMessage key={message.id} message={message}
          onSend={props.onSend} onOpenWorkflow={props.onOpenWorkflow} />)}

        {props.planning && <article className="chat-message-card agent pending"><span className="chat-message-avatar"><Sparkles size={15} /></span>
          <div><header><strong>Mixer Agent</strong></header><p><LoaderCircle className="spin" size={14} /> 分析手順を確認しています…</p>
            <GenerationTimeline activities={props.activeGenerations} />
            <ToolActivityTimeline activities={props.activeToolCalls} /></div></article>}

        {props.proposal && <section className="analysis-plan-card" aria-label="Workflowへの変更案">
          <header><div><GitBranch size={18} /><div><span>ANALYSIS PLAN</span><strong>{props.proposal.plan.summary}</strong></div></div>
            <button aria-label="提案を閉じる" onClick={props.onDiscardProposal}><X size={15} /></button></header>
          <div className="plan-sources"><span>使用するデータ</span>{props.proposal.plan.dataSources.length > 0
            ? props.proposal.plan.dataSources.map((source) => <strong key={source.id}><Database size={12} />{source.name}</strong>)
            : <em>データソース未選択</em>}</div>
          <ol>{props.proposal.plan.steps.map((step, index) => <li key={`${index}-${step.title}`}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.description}</p></div></li>)}</ol>
          {props.proposal.plan.warnings.length > 0 && <div className="plan-warnings"><CircleAlert size={14} /><ul>{props.proposal.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          <div className="plan-changes"><span>Workflowの変更点</span><ul>{props.proposal.changes.map((change) => <li key={change}><Check size={12} />{change}</li>)}</ul></div>
          <footer><button onClick={props.onDiscardProposal}>破棄</button><button onClick={props.onOpenWorkflow}>ノードで確認</button>
            <button onClick={props.onApplyProposal}>Workflowへ反映 <ArrowRight size={14} /></button>
            <button className="primary" onClick={props.onApplyProposalAndRun}><Play size={13} fill="currentColor" />反映して実行</button></footer>
        </section>}

        <div ref={messagesEnd} />
      </div>

      <div className="chat-composer-area">
        {props.messages.length === 0 && <div className="chat-suggestions">{suggestions.map((suggestion) => <button key={suggestion}
          disabled={props.planning} onClick={() => props.onSend(suggestion)}>{suggestion}</button>)}</div>}
        <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); props.onSend() }}>
          <textarea aria-label="分析したい内容" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
              if (event.key === 'Enter' && !event.shiftKey && !composing) {
                event.preventDefault()
                props.onSend()
              }
            }}
            placeholder="例: 先月の商品別売上を顧客区分ごとに比較したい" rows={3} />
          <div><span><CircleAlert size={12} /> データへアクセスする前に計画を表示します</span>
            <button type="submit" disabled={!props.prompt.trim() || props.planning}><Send size={15} /><span>送信</span></button></div>
        </form>
        <div className="chat-workflow-context"><WorkflowIcon size={13} /><span>現在のWorkflow:</span><strong>{props.workflow.name}</strong><em>{props.workflow.steps.length} steps</em>
          <button onClick={props.onRunWorkflow} disabled={props.executing || props.planning || !!props.proposal}>
            {props.executing ? <LoaderCircle className="spin" size={13} /> : <Play size={12} fill="currentColor" />}<span>{props.executing ? '実行中' : 'Workflowを実行'}</span>
          </button>
        </div>
      </div>
    </div>
    {usageNotesOpen ? <UsageNotesDialog onClose={() => setUsageNotesOpen(false)} /> : null}
  </section>
}
