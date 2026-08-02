// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleWorkflow, type WorkflowRun } from '../shared/workflow'
import { ChatWorkspace } from './ChatWorkspace'

const baseProps = {
  workflow: sampleWorkflow,
  dataSources: [],
  conversations: [],
  messages: [],
  planning: false,
  activeToolCalls: [],
  activeGenerations: [],
  executing: false,
  prompt: '',
  onPromptChange: vi.fn(),
  onSend: vi.fn(),
  onNewConversation: vi.fn(),
  onOpenConversation: vi.fn(),
  onOpenWorkflow: vi.fn(),
  onRunWorkflow: vi.fn(),
  onApplyProposal: vi.fn(),
  onApplyProposalAndRun: vi.fn(),
  onDiscardProposal: vi.fn(),
}

afterEach(cleanup)

describe('ChatWorkspace', () => {
  it('does not expose BFF model configuration in the user interface', () => {
    render(<ChatWorkspace {...baseProps} prompt="売上を見たい" />)
    expect(screen.getByText('Mixer Agent')).toBeTruthy()
    expect(screen.queryByText(/OpenAI互換|モデルAPI|local-model/)).toBeNull()
    expect(screen.getByRole('button', { name: '送信' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'ノードで詳細を開く' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows one concise usage note only when requested', async () => {
    render(<ChatWorkspace {...baseProps} />)
    expect(screen.queryByRole('dialog', { name: '仕様・注意事項' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '仕様・注意事項' }))
    const dialog = screen.getByRole('dialog', { name: '仕様・注意事項' })
    expect(dialog.querySelectorAll('li')).toHaveLength(1)
    expect(dialog.textContent).toContain('同じ依頼の中では取得済みのデータを使います。最新データが必要な場合は、新しい依頼として再取得してください。')

    await userEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog', { name: '仕様・注意事項' })).toBeNull()
  })

  it('renders clarification choices and sends the selected answer', async () => {
    const onSend = vi.fn()
    render(<ChatWorkspace {...baseProps} onSend={onSend} messages={[{ id: 'm1', role: 'agent', text: '期間を確認します。', metadata: {
      state: 'clarification', message: '期間を確認します。', changes: [],
        questions: [{ id: 'period', prompt: '対象期間はいつですか？', choices: ['先月', '今月'] }],
        toolCalls: [],
      } }]} />)
    await userEvent.click(screen.getByRole('button', { name: '先月' }))
    expect(onSend).toHaveBeenCalledWith('先月')
  })

  it('does not send when Enter confirms an IME composition', () => {
    const onSend = vi.fn()
    render(<ChatWorkspace {...baseProps} prompt="売上を確認したい" onSend={onSend} />)
    const composer = screen.getByRole('textbox', { name: '分析したい内容' })

    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', isComposing: true })
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', keyCode: 229 })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends with an ordinary Enter while preserving Shift+Enter for a newline', () => {
    const onSend = vi.fn()
    render(<ChatWorkspace {...baseProps} prompt="売上を確認したい" onSend={onSend} />)
    const composer = screen.getByRole('textbox', { name: '分析したい内容' })

    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' })
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('renders bounded MCP preview rows directly in the conversation', () => {
    render(<ChatWorkspace {...baseProps} messages={[{ id: 'sample', role: 'agent', text: '形式確認用の3件です。', metadata: {
      state: 'answer', message: '形式確認用の3件です。', changes: [], sourceIds: ['sales'], reason: 'format inspection',
      toolCalls: [],
      catalogs: [],
      artifacts: [{ id: 'artifact-sample', type: 'table', name: 'sales-preview', rowCount: 2, columns: ['category', 'amount'],
        preview: [{ category: 'Hardware', amount: 1200 }, { category: 'Software', amount: 850 }], provenance: ['source:sales'],
        trustLevel: 'untrusted', classification: 'internal', checksum: 'checksum', createdAt: new Date().toISOString() }],
    } }]} />)
    const sample = screen.getByRole('region', { name: '取得データ' })
    expect(sample.textContent).toContain('Hardware')
    expect(sample.textContent).toContain('1200')
    expect(sample.textContent).toContain('信頼されない入力データ')
  })

  it('renders MCP Catalog fields as structured data instead of relying on model prose', () => {
    render(<ChatWorkspace {...baseProps} messages={[{ id: 'catalog', role: 'agent', text: '利用できる項目を確認しました。', metadata: {
      state: 'answer', message: '利用できる項目を確認しました。', changes: [], sourceIds: ['local-sql'], reason: 'catalog lookup',
      artifacts: [],
      toolCalls: [{ id: 'call-1', tool: 'catalog_describe', label: 'Data Catalogを取得', status: 'completed', durationMs: 4 }],
      catalogs: [{
        sourceId: 'local-sql', displayName: 'ローカル売上', description: '受注明細', dataModel: 'table',
        scope: 'canonical', version: 3, relationships: [],
        fields: [
          { path: 'category', dataTypes: ['string'], nullable: false, presence: 1, repeated: false,
            businessName: '商品カテゴリ', description: '商品の分類', unit: '', timezone: '' },
          { path: 'amount', dataTypes: ['number'], nullable: false, presence: 0.98, repeated: false,
            businessName: '売上金額', description: '税抜金額', unit: 'JPY', timezone: '' },
        ],
      }],
    } }]} />)

    const catalog = screen.getByRole('region', { name: 'ローカル売上のData Catalog' })
    expect(catalog.textContent).toContain('local-sql')
    expect(catalog.textContent).toContain('category')
    expect(catalog.textContent).toContain('商品カテゴリ')
    expect(catalog.textContent).toContain('amount')
    expect(catalog.textContent).toContain('98%')
    expect(screen.getByRole('region', { name: 'MCPツール実行状況' }).textContent).toContain('catalog_describe')
  })

  it('shows a reviewable plan and keeps apply and node review as separate actions', async () => {
    const onApply = vi.fn()
    const onApplyAndRun = vi.fn()
    const onOpen = vi.fn()
    render(<ChatWorkspace {...baseProps} onApplyProposal={onApply} onApplyProposalAndRun={onApplyAndRun} onOpenWorkflow={onOpen}
      proposal={{ state: 'proposal', conversationId: 'conv-1',
        message: '計画を作りました。', changes: ['プレビューを追加'], workflow: sampleWorkflow,
        plan: { summary: '売上を確認します。', dataSources: [{ id: 'sales', name: '売上' }],
          steps: [{ title: '取得', description: '売上を読み取ります。' }], warnings: ['期間を確認してください。'] },
        toolCalls: [] }} />)
    expect(screen.getByText('売上を確認します。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Workflowへ反映/ }))
    await userEvent.click(screen.getByRole('button', { name: /反映して実行/ }))
    await userEvent.click(screen.getAllByRole('button', { name: /ノードで/ }).at(-1)!)
    expect(onApply).toHaveBeenCalledOnce()
    expect(onApplyAndRun).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows each MCP tool call with its live status', () => {
    render(<ChatWorkspace {...baseProps} planning activeToolCalls={[
      { id: 'call-1', tool: 'catalog_explore_personal', label: '売上データの形式を探索', status: 'completed', durationMs: 24 },
      { id: 'call-2', tool: 'data_source_sample', label: '顧客データのサンプルを取得', status: 'running' },
    ]} />)

    const timeline = screen.getByRole('region', { name: 'MCPツール実行状況' })
    expect(timeline.textContent).toContain('売上データの形式を探索')
    expect(timeline.textContent).toContain('catalog_explore_personal')
    expect(timeline.textContent).toContain('24msで完了')
    expect(timeline.textContent).toContain('顧客データのサンプルを取得')
    expect(timeline.textContent).toContain('実行中')
  })

  it('shows live generated-token estimates separately from MCP activity', () => {
    render(<ChatWorkspace {...baseProps} planning activeGenerations={[
      { kind: 'generation', id: 'generation-1', status: 'running', generatedTokens: 128, tokenCount: 'estimated',
        contentCharacters: 96, reasoningCharacters: 288, elapsedMs: 1_240 },
    ]} />)

    const timeline = screen.getByRole('region', { name: 'モデル生成状況' })
    expect(timeline.textContent).toContain('約128 tokens')
    expect(timeline.textContent).toContain('本文 96文字')
    expect(timeline.textContent).toContain('推論 288文字')
    expect(timeline.textContent).toContain('生成中')
  })

  it('keeps sanitized provider diagnostics behind an error detail toggle', async () => {
    render(<ChatWorkspace {...baseProps} messages={[{ id: 'error', role: 'system', text: '応答を処理できませんでした。',
      diagnostic: { code: 'agent_invalid_response', requestId: 'request-1', details: {
        providerResponse: { finishReason: 'stop', contentPreview: 'not-json', reasoningCharacters: 42 },
      } },
    }]} />)

    const toggle = screen.getByText('エラー詳細を表示')
    const details = toggle.closest('details')!
    expect(details.hasAttribute('open')).toBe(false)
    await userEvent.click(toggle)
    expect(details.hasAttribute('open')).toBe(true)
    expect(details.textContent).toContain('agent_invalid_response')
    expect(details.textContent).toContain('not-json')
    expect(details.textContent).toContain('hidden reasoning本文と認証情報は表示されません')
  })

  it('runs the current workflow explicitly and summarizes the latest result', async () => {
    const onRun = vi.fn()
    const run = {
      id: 'run-1', workflowId: sampleWorkflow.id, status: 'completed', startedAt: new Date().toISOString(), durationMs: 42,
      steps: [], finalArtifact: { id: 'artifact-1', type: 'table', name: '売上プレビュー', rowCount: 12,
        columns: ['count'], preview: [{ count: 9 }], provenance: ['sales'], trustLevel: 'untrusted', classification: 'internal',
        checksum: 'checksum', createdAt: new Date().toISOString() },
    } satisfies WorkflowRun
    render(<ChatWorkspace {...baseProps} onRunWorkflow={onRun}
      messages={[
        { id: 'run-message', role: 'system', text: 'Workflowを実行しました。', run },
        { id: 'later-message', role: 'user', text: '続けて別の集計を試したい' },
      ]} />)
    await userEvent.click(screen.getByRole('button', { name: /Workflowを実行/ }))
    expect(onRun).toHaveBeenCalledOnce()
    const runResult = screen.getByRole('region', { name: 'Workflow実行結果' })
    expect(runResult.textContent).toContain('12')
    expect(screen.getByRole('cell', { name: '9' })).toBeTruthy()
    expect(screen.getByText('売上プレビュー')).toBeTruthy()
    expect(runResult.compareDocumentPosition(screen.getByText('続けて別の集計を試したい'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
