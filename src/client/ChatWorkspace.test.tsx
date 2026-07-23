// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleWorkflow } from '../shared/workflow'
import { ChatWorkspace } from './ChatWorkspace'

const baseProps = {
  provider: { provider: 'disabled' as const, label: 'モデルAPI未設定', configured: false },
  workflow: sampleWorkflow,
  dataSources: [],
  conversations: [],
  messages: [],
  planning: false,
  executing: false,
  prompt: '',
  onPromptChange: vi.fn(),
  onSend: vi.fn(),
  onNewConversation: vi.fn(),
  onOpenConversation: vi.fn(),
  onOpenWorkflow: vi.fn(),
  onRunWorkflow: vi.fn(),
  onApplyProposal: vi.fn(),
  onDiscardProposal: vi.fn(),
}

afterEach(cleanup)

describe('ChatWorkspace', () => {
  it('keeps a visible warning on explicitly approved private-network HTTP model transport', () => {
    render(<ChatWorkspace {...baseProps} provider={{ provider: 'openai-compatible', label: 'OpenAI互換 API', configured: true,
      model: 'local-model', transportSecurity: 'private-http' }} />)
    expect(screen.getByText('モデルAPIはLAN内の平文HTTP接続です')).toBeTruthy()
    expect(screen.getByText(/本番ではHTTPSへ切り替えてください/)).toBeTruthy()
  })

  it('explains that the model API is not configured and does not pretend the agent is online', () => {
    render(<ChatWorkspace {...baseProps} prompt="売上を見たい" />)
    expect(screen.getByText('分析エージェントは接続待ちです')).toBeTruthy()
    expect(screen.getByRole('button', { name: '送信' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'ノードで詳細を開く' }).hasAttribute('disabled')).toBe(false)
  })

  it('renders clarification choices and sends the selected answer', async () => {
    const onSend = vi.fn()
    render(<ChatWorkspace {...baseProps} provider={{ provider: 'openai-compatible', label: 'OpenAI互換 API', configured: true, model: 'local-model' }}
      onSend={onSend} messages={[{ id: 'm1', role: 'agent', text: '期間を確認します。', metadata: {
        state: 'clarification', message: '期間を確認します。', changes: [],
        questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月', '今月'] }],
      } }]} />)
    await userEvent.click(screen.getByRole('button', { name: '先月' }))
    expect(onSend).toHaveBeenCalledWith('先月')
  })

  it('renders bounded sample rows directly in the conversation', () => {
    render(<ChatWorkspace {...baseProps} messages={[{ id: 'sample', role: 'agent', text: '形式確認用の3件です。', metadata: {
      state: 'sample', message: '形式確認用の3件です。', changes: [], sourceIds: ['sales'], limit: 3, reason: 'format inspection',
      artifact: { id: 'artifact-sample', type: 'table', name: 'sales-preview', rowCount: 2, columns: ['category', 'amount'],
        preview: [{ category: 'Hardware', amount: 1200 }, { category: 'Software', amount: 850 }], provenance: ['source:sales'],
        trustLevel: 'untrusted', classification: 'internal', checksum: 'checksum', createdAt: new Date().toISOString() },
    } }]} />)
    const sample = screen.getByRole('region', { name: 'サンプルデータ' })
    expect(sample.textContent).toContain('Hardware')
    expect(sample.textContent).toContain('1200')
    expect(sample.textContent).toContain('信頼されない入力データ')
  })

  it('shows a reviewable plan and keeps apply and node review as separate actions', async () => {
    const onApply = vi.fn()
    const onOpen = vi.fn()
    render(<ChatWorkspace {...baseProps} provider={{ provider: 'openai-compatible', label: 'OpenAI互換 API', configured: true, model: 'local-model' }}
      onApplyProposal={onApply} onOpenWorkflow={onOpen} proposal={{ state: 'proposal', conversationId: 'conv-1',
        provider: { provider: 'openai-compatible', label: 'OpenAI互換 API', configured: true, model: 'local-model' },
        message: '計画を作りました。', changes: ['プレビューを追加'], workflow: sampleWorkflow,
        plan: { summary: '売上を確認します。', dataSources: [{ id: 'sales', name: '売上' }],
          steps: [{ title: '取得', description: '売上を読み取ります。' }], warnings: ['期間を確認してください。'] } }} />)
    expect(screen.getByText('売上を確認します。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Workflowへ反映/ }))
    await userEvent.click(screen.getAllByRole('button', { name: /ノードで/ }).at(-1)!)
    expect(onApply).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('runs the current workflow explicitly and summarizes the latest result', async () => {
    const onRun = vi.fn()
    render(<ChatWorkspace {...baseProps} onRunWorkflow={onRun} run={{
      id: 'run-1', workflowId: sampleWorkflow.id, status: 'completed', startedAt: new Date().toISOString(), durationMs: 42,
      steps: [], finalArtifact: { id: 'artifact-1', type: 'table', name: '売上プレビュー', rowCount: 12,
        columns: ['category', 'amount'], preview: [], provenance: ['sales'], trustLevel: 'untrusted', classification: 'internal',
        checksum: 'checksum', createdAt: new Date().toISOString() },
    }} />)
    await userEvent.click(screen.getByRole('button', { name: /Workflowを実行/ }))
    expect(onRun).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: '最新の実行結果' }).textContent).toContain('12')
    expect(screen.getByText('売上プレビュー')).toBeTruthy()
  })
})
