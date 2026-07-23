import { memo, useEffect, useMemo, useRef } from 'react'
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Database,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Send,
  Sparkles,
  Table2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react'
import type { AgentProviderStatus, AgentResponse } from '../shared/api'
import type { Workflow, WorkflowRun } from '../shared/workflow'
import type { DataSource } from './api'

type StoredAgentResponse<T> = T extends unknown ? Omit<T, 'conversationId' | 'provider'> : never
export type AgentMessageMetadata = StoredAgentResponse<AgentResponse>

export type ChatViewMessage = {
  id: string
  role: 'agent' | 'user' | 'system'
  text: string
  metadata?: AgentMessageMetadata
}

type ConversationSummary = { id: string; title: string; workflowId: string | null; updatedAt: string }

type ChatWorkspaceProps = {
  provider: AgentProviderStatus
  workflow: Workflow
  dataSources: DataSource[]
  conversations: ConversationSummary[]
  conversationId?: string
  messages: ChatViewMessage[]
  proposal?: Extract<AgentResponse, { state: 'proposal' }>
  run?: WorkflowRun
  planning: boolean
  executing: boolean
  prompt: string
  onPromptChange: (value: string) => void
  onSend: (message?: string) => void
  onNewConversation: () => void
  onOpenConversation: (id: string) => void
  onOpenWorkflow: () => void
  onRunWorkflow: () => void
  onApplyProposal: () => void
  onDiscardProposal: () => void
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

function AgentMessage({ message, onSend }: { message: ChatViewMessage; onSend: (message?: string) => void }) {
  const metadata = message.metadata
  return <article className={`chat-message-card ${message.role}`}>
    <span className="chat-message-avatar">{message.role === 'agent' ? <Sparkles size={15} /> : message.role === 'user' ? 'YOU' : <Bot size={15} />}</span>
    <div>
      <header><strong>{message.role === 'agent' ? 'Mixer Agent' : message.role === 'user' ? 'あなた' : 'システム'}</strong></header>
      <p>{message.text}</p>
      {metadata?.state === 'sample' && <section className="chat-sample" aria-label="サンプルデータ">
        <header><Table2 size={14} /><strong>サンプルデータ</strong><span>{metadata.artifact.rowCount}件</span></header>
        <div><table><thead><tr>{metadata.artifact.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{(metadata.artifact.preview ?? []).map((row, index) => <tr key={index}>{metadata.artifact.columns.map((column) => {
            const value = row[column]
            return <td key={column}>{value === null ? <em>null</em> : typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
          })}</tr>)}</tbody></table></div>
        <footer>表示内容は信頼されない入力データとして扱われます。</footer>
      </section>}
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
        <div><span className="agent-avatar"><Sparkles size={17} /></span><div><strong>Mixer Agent</strong>
          <small className={props.provider.configured ? 'ready' : 'offline'}><span />
            {props.provider.configured ? `${props.provider.label} · ${props.provider.model}` : 'モデルAPI未設定'}</small></div></div>
        <button className="toolbar-button" onClick={props.onOpenWorkflow}><WorkflowIcon size={15} /><span>ノードで詳細を開く</span></button>
      </header>

      {!props.provider.configured && <div className="agent-setup-banner" role="status">
        <CircleAlert size={18} />
        <div><strong>分析エージェントは接続待ちです</strong><span>チャットUIと会話保存は利用できます。OpenAI互換APIの接続先とモデルを設定すると応答できるようになります。</span></div>
      </div>}
      {props.provider.transportSecurity === 'private-http' ? <div className="agent-setup-banner agent-transport-warning" role="status">
        <CircleAlert size={16} /><div><strong>モデルAPIはLAN内の平文HTTP接続です</strong>
          <span>明示承認されたprivate IPv4 endpointを使用しています。本番ではHTTPSへ切り替えてください。</span></div>
      </div> : null}

      <div className="chat-scroll-region" aria-live="polite">
        {props.messages.length === 0 ? <section className="chat-welcome">
          <span><Sparkles size={24} /></span>
          <p className="eyebrow">AI-ASSISTED ANALYSIS</p>
          <h1>何を知りたいですか？</h1>
          <p>目的を業務用語で入力してください。利用可能なデータを確認し、必要な質問をしたうえで、実行前に分析計画を提示します。</p>
          <div className="chat-source-summary"><Database size={15} /><strong>{props.dataSources.length}件のデータソース</strong>
            <span>{props.dataSources.length > 0 ? props.dataSources.slice(0, 3).map((source) => source.name).join('、') : '管理者による登録を待っています'}</span></div>
        </section> : props.messages.map((message) => <AgentMessage key={message.id} message={message} onSend={props.onSend} />)}

        {props.planning && <article className="chat-message-card agent pending"><span className="chat-message-avatar"><Sparkles size={15} /></span>
          <div><header><strong>Mixer Agent</strong></header><p><LoaderCircle className="spin" size={14} /> 目的と現在のWorkflowを確認しています…</p></div></article>}

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
            <button className="primary" onClick={props.onApplyProposal}>Workflowへ反映 <ArrowRight size={14} /></button></footer>
        </section>}

        {props.run && <section className="chat-run-card" aria-label="最新の実行結果">
          <header><div><Check size={16} /><span>LATEST RUN</span></div><strong>Workflowの実行が完了しました</strong></header>
          <div className="chat-run-metrics">
            <span><strong>{props.run.finalArtifact.rowCount.toLocaleString('ja-JP')}</strong>行</span>
            <span><strong>{props.run.finalArtifact.columns.length}</strong>列</span>
            <span><strong>{props.run.durationMs.toLocaleString('ja-JP')}</strong>ms</span>
          </div>
          <p><Table2 size={14} /><strong>{props.run.finalArtifact.name}</strong><span>{props.run.finalArtifact.columns.slice(0, 5).join('、')}</span></p>
          <footer><span>入力データは信頼されないデータとして処理されました。</span><button onClick={props.onOpenWorkflow}>結果の詳細を確認</button></footer>
        </section>}
        <div ref={messagesEnd} />
      </div>

      <div className="chat-composer-area">
        {props.messages.length === 0 && <div className="chat-suggestions">{suggestions.map((suggestion) => <button key={suggestion}
          disabled={props.planning || !props.provider.configured} onClick={() => props.onSend(suggestion)}>{suggestion}</button>)}</div>}
        <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); props.onSend() }}>
          <textarea aria-label="分析したい内容" value={props.prompt} onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onSend() } }}
            placeholder="例: 先月の商品別売上を顧客区分ごとに比較したい" rows={3} />
          <div><span><CircleAlert size={12} /> データへアクセスする前に計画を表示します</span>
            <button type="submit" disabled={!props.prompt.trim() || props.planning || !props.provider.configured}><Send size={15} /><span>送信</span></button></div>
        </form>
        <div className="chat-workflow-context"><WorkflowIcon size={13} /><span>現在のWorkflow:</span><strong>{props.workflow.name}</strong><em>{props.workflow.steps.length} steps</em>
          <button onClick={props.onRunWorkflow} disabled={props.executing || props.planning || !!props.proposal}>
            {props.executing ? <LoaderCircle className="spin" size={13} /> : <Play size={12} fill="currentColor" />}<span>{props.executing ? '実行中' : 'Workflowを実行'}</span>
          </button>
        </div>
      </div>
    </div>
  </section>
}
