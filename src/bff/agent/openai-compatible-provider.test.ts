import { describe, expect, it, vi } from 'vitest'
import { sampleWorkflow } from '../../shared/workflow'
import { OpenAiCompatibleAgentModel } from './openai-compatible-provider'
import { parseAgentDecisionWire } from './provider'

const unusedToolFields = { tool: 'none' as const, sourceId: '', artifactId: '' }
const unavailableWorkflowExecution = {
  available: false,
  workflowId: sampleWorkflow.id,
  requiresApproval: false,
}

describe('OpenAI-compatible agent provider', () => {
  it('supports explanation-only and bounded tool decisions without creating a Workflow', () => {
    expect(parseAgentDecisionWire({ state: 'answer', message: '現在は地域別集計です。', changes: [], questions: [],
      sourceIds: [], limit: 0, reason: 'current workflow explanation', ...unusedToolFields })).toMatchObject({ state: 'answer' })
    expect(parseAgentDecisionWire({ state: 'tool', message: '3件を取得します。', changes: [], questions: [],
      sourceIds: [], limit: 3, reason: 'format inspection', tool: 'data_source_sample', sourceId: 'sales', artifactId: '' }))
      .toMatchObject({ state: 'tool', tool: 'data_source_sample', sourceId: 'sales', limit: 3 })
    expect(parseAgentDecisionWire({ state: 'tool', message: '保存済みWorkflowを実行します。', changes: [], questions: [],
      sourceIds: [], limit: 0, reason: 'explicit execution request', tool: 'workflow_execute', sourceId: '', artifactId: '' }))
      .toMatchObject({ state: 'tool', tool: 'workflow_execute' })
  })

  it('requests a strict structured Workflow response from the configured endpoint', async () => {
    const modelResponse = {
      state: 'proposal',
      message: '登録済みデータをプレビューする計画です。',
      changes: ['プレビューを追加'],
      workflow: { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
        ? { ...step, config: { ...step.config, source: 'sales' } } : step) },
      plan: {
        summary: '登録済みデータの内容を確認します。',
        dataSources: [{ id: 'sales', name: '売上' }],
        steps: [{ title: 'データを取得', description: '売上データを読み取ります。' }],
        warnings: [],
      },
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ state: 'proposal', message: modelResponse.message,
          changes: modelResponse.changes, questions: [], sourceIds: [], limit: 0, reason: '', ...unusedToolFields }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(modelResponse) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768,
      reasoningEffort: 'low' }, fetchMock)

    const response = await provider.respond({ message: '売上を見たい', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution,
      dataSources: [{ id: 'sales', name: '売上', type: 'database-table', dataModel: 'table' }], catalogs: [], history: [] })
    expect(response).toMatchObject({ ...modelResponse, plan: { ...modelResponse.plan,
      steps: expect.arrayContaining([expect.objectContaining({ title: 'データを取得' })]) } })
    expect(response.state === 'proposal' ? response.plan.steps : []).toHaveLength(modelResponse.workflow.steps.length)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://models.example.com/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'local-model', temperature: 0.1, max_tokens: 4_096, reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { strict: true } } })
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('propertyNames')
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('oneOf')
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('maxLength')
    expect(JSON.stringify(body.messages)).not.toContain('connectionString')
    const proposalBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { messages: Array<{ content: string }> }
    expect(proposalBody.messages.at(-1)?.content).toContain('applicationContext.availableDataSources')
    expect(proposalBody.messages.at(-1)?.content).toContain('applicationContext.availableCatalogs')
    expect(proposalBody.messages.at(-1)?.content).toContain('applicationContext.currentWorkflow')
  })

  it('omits reasoning_effort when the operator has not configured it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: '回答します。', changes: [], questions: [], sourceIds: [], limit: 0,
      reason: 'answer', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: 'test', workflow: sampleWorkflow, workflowExecution: unavailableWorkflowExecution,
      dataSources: [], catalogs: [], history: [] })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('puts the latest user request after application context and conversation history', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: 'local-salesの項目を説明します。', changes: [], questions: [], sourceIds: [], limit: 0,
      reason: 'latest request', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: 'local-salesの内容と利用できる項目を教えてください', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution,
      dataSources: [{ id: 'local-sales', name: 'Local Sales', type: 'database-table', dataModel: 'table' }], catalogs: [],
      history: [{ role: 'user', content: '君ができることは何か教えて' },
        { role: 'assistant', content: '私は分析Workflowを作成できます。' }] })

    const messages = (JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ role: string; content: string }> }).messages
    expect(messages.slice(1, 3)).toEqual([
      { role: 'user', content: '君ができることは何か教えて' },
      { role: 'assistant', content: '私は分析Workflowを作成できます。' },
    ])
    expect(messages[0]?.content).toContain('applicationContext.currentWorkflow')
    expect(messages[0]?.content).toContain('currentTurnState.toolResults')
    expect(messages[0]?.content).toContain('priorResultContext')
    expect(messages[0]?.content).toContain('currentRequest.message')
    expect(messages.at(-4)?.content).toContain('applicationContext:\n{"availableDataSources"')
    expect(messages.at(-3)?.content).toContain(
      'currentTurnState:\n{"events":[],"toolResults":[],"proposalValidationErrors":[],"workflowExecutionCompleted":false}')
    expect(messages.at(-2)?.content).toContain('priorResultContext:\n[]')
    expect(messages.slice(-4, -1).every((message) => !message.content.includes('currentRequest:'))).toBe(true)
    expect(messages.at(-1)).toMatchObject({ role: 'user' })
    expect(messages.at(-1)?.content).toBe(
      'currentRequest:\n{"message":"local-salesの内容と利用できる項目を教えてください"}')
    expect(JSON.stringify(messages).match(/local-salesの内容と利用できる項目を教えてください/g)).toHaveLength(1)
  })

  it('provides MCP structured results to the model as authoritative application context', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: 'amountは数値項目です。', changes: [], questions: [], sourceIds: ['local-sql'], limit: 0,
      reason: 'MCP Catalog', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: 'local-sqlの項目を教えて', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution,
      dataSources: [{ id: 'local-sql', name: 'Local SQL', type: 'database-table', dataModel: 'table' }], catalogs: [], history: [],
      toolResults: [{ callId: 'call-1', tool: 'catalog_describe', input: { sourceId: 'local-sql' },
        result: { effective: { definition: { fields: [{ path: 'amount', dataTypes: ['number'] }] } } } }] })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ content: string }> }
    expect(body.messages.at(-3)?.content).toContain('今回の依頼内でBFFが確認した処理状態')
    expect(body.messages.at(-3)?.content).toContain('currentTurnState:\n{"events":[],"toolResults"')
    expect(body.messages.at(-3)?.content).toContain('"tool":"catalog_describe"')
    expect(body.messages.at(-3)?.content).toContain('"input":{"sourceId":"local-sql"}')
    expect(body.messages.at(-3)?.content).toContain('"path":"amount"')
    expect(body.messages.at(-1)?.content).toContain('local-sqlの項目を教えて')
    expect(body.messages.at(-1)?.content).not.toContain('"tool":"catalog_describe"')
  })

  it('places BFF proposal validation feedback in the documented current-turn section', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: '修正します。', changes: [], questions: [], sourceIds: [], limit: 0,
      reason: 'validation feedback', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: '複雑な集計を提案してください', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution, dataSources: [], catalogs: [], history: [],
      currentTurn: { events: [], proposalValidationErrors: [
        '「集計」のグループ列「category, sales_channel」は入力のData Catalogにありません。',
      ] } })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ content: string }> }
    expect(body.messages.at(-3)?.content).toContain('"proposalValidationErrors":["「集計」のグループ列')
    expect(body.messages[0]?.content).toContain('currentTurnState.proposalValidationErrors')
  })

  it('keeps previously displayed Artifact values separate from history and the current request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: '1行目はORD-2026-001、Hardware、1280です。', changes: [], questions: [],
      sourceIds: [], limit: 0, reason: '表示済み結果', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: '表示した1行目を教えてください', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution, dataSources: [], catalogs: [],
      history: [{ role: 'user', content: 'サンプルを見せて' }, { role: 'assistant', content: '3件表示しました。' }],
      priorResults: [{ messageSequence: 2, artifacts: [{
        type: 'table', name: 'sample', rowCount: 3, columns: ['order_id', 'category', 'amount'],
        preview: [{ order_id: 'ORD-2026-001', category: 'Hardware', amount: 1280 }],
        createdAt: '2026-07-28T00:00:00.000Z',
      }] }],
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ role: string; content: string }> }
    const prior = body.messages.find((message) => message.content.includes('過去ターンで利用者へ表示済み'))
    expect(prior?.content).toContain('priorResultContext:\n[')
    expect(prior?.content).toContain('"order_id":"ORD-2026-001"')
    expect(body.messages.slice(1, 3)).toEqual([
      { role: 'user', content: 'サンプルを見せて' },
      { role: 'assistant', content: '3件表示しました。' },
    ])
    expect(body.messages.at(-1)?.content).toBe('currentRequest:\n{"message":"表示した1行目を教えてください"}')
    expect(body.messages.at(-1)?.content).not.toContain('ORD-2026-001')
  })

  it('requires a result-based final answer after Workflow execution succeeds', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: '集計結果はHardwareが9件、Servicesが9件、Softwareが12件です。',
      changes: [], questions: [], sourceIds: [], limit: 0, reason: '実行結果', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await expect(provider.respond({ message: 'ワークフローを実行してください', workflow: sampleWorkflow,
      workflowExecution: { available: true, workflowId: sampleWorkflow.id, version: 1, requiresApproval: false },
      dataSources: [], catalogs: [], history: [],
      toolResults: [{ callId: 'call-run', tool: 'workflow_execute',
        input: { workflowId: sampleWorkflow.id, version: 1 },
        result: { id: 'run-1', workflowId: sampleWorkflow.id, status: 'succeeded',
          startedAt: '2026-07-28T00:00:00.000Z', durationMs: 42, stepCount: 2,
          finalArtifact: { kind: 'table', columns: ['category', 'count'], rows: [
            { category: 'Hardware', count: 9 }, { category: 'Services', count: 9 }, { category: 'Software', count: 12 },
          ], rowCount: 3, truncated: false } } }] }))
      .resolves.toMatchObject({ state: 'answer', message: expect.stringContaining('Hardwareが9件') })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>
      response_format: { json_schema: { name: string } }
    }
    expect(body.response_format.json_schema.name).toBe('multi_metric_mixer_workflow_result')
    expect(body.messages.at(-3)?.content).toContain('"category":"Software","count":12')
    expect(body.messages.at(-3)?.content).toContain('"workflowExecutionCompleted":true')
    expect(body.messages.at(-1)?.content).toBe('currentRequest:\n{"message":"ワークフローを実行してください"}')
    expect(body.messages.at(-1)?.content).not.toContain('"category":"Software","count":12')
  })

  it('retries one invalid Workflow proposal and returns a repaired response', async () => {
    const validWorkflow = { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, source: 'sales' } } : step) }
    const decision = { state: 'proposal', message: '計画します。', changes: ['地域別に集計'], questions: [], sourceIds: [],
      limit: 0, reason: '', ...unusedToolFields }
    const validProposal = { state: 'proposal', message: '計画しました。', changes: ['地域別に集計'], workflow: validWorkflow,
      plan: { summary: '地域別集計', dataSources: [{ id: 'sales', name: '売上' }],
        steps: validWorkflow.steps.map((step) => ({ title: step.title, description: `${step.title}を実行します。` })), warnings: [] } }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...validProposal,
        workflow: { ...validWorkflow, steps: validWorkflow.steps.map((step) => 'input' in step ? { ...step, input: 'missing-step' } : step) } }) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validProposal) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await expect(provider.respond({ message: '地域別に集計', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution,
      dataSources: [{ id: 'sales', name: '売上', type: 'database-table', dataModel: 'table' }], catalogs: [], history: [] }))
      .resolves.toMatchObject({ state: 'proposal', workflow: validWorkflow })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('normalizes an empty aggregate grouping into a whole-table row count', async () => {
    const decision = { state: 'proposal', message: '件数を確認します。', changes: ['Hardwareを数える'],
      questions: [], sourceIds: [], limit: 0, reason: '', ...unusedToolFields }
    const countWorkflow = {
      version: 1 as const,
      id: 'wf-count',
      name: 'Hardware件数',
      description: '',
      steps: [
        { id: 'read', kind: 'query' as const, title: '取得', config: { source: 'sales', parameters: {}, template: null } },
        { id: 'filter', kind: 'filterSelect' as const, title: '絞り込み', input: 'read',
          config: { columns: ['*'], filters: [{ field: 'category', operator: 'eq' as const, value: 'Hardware' }] } },
        { id: 'count', kind: 'aggregate' as const, title: '件数', input: 'filter',
          config: { groupBy: '', metric: '{"field":"id","operation":"count"}', operation: 'count' as const } },
        { id: 'preview', kind: 'preview' as const, title: '表示', input: 'count', config: { limit: 1 } },
      ],
    }
    const proposal = { state: 'proposal', message: '計画しました。', changes: ['Hardwareを数える'],
      workflow: countWorkflow, plan: { summary: '件数', dataSources: [{ id: 'sales', name: '売上' }],
        steps: countWorkflow.steps.map((step) => ({ title: step.title, description: step.title })), warnings: [] } }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    const response = await provider.respond({ message: 'Hardwareの行数', workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution,
      dataSources: [{ id: 'sales', name: '売上', type: 'database-table', dataModel: 'table' }],
      catalogs: [], history: [] })

    expect(response).toMatchObject({ state: 'proposal', workflow: { steps: expect.arrayContaining([
      expect.objectContaining({ kind: 'filterSelect', config: expect.objectContaining({ columns: [] }) }),
      expect.objectContaining({ kind: 'aggregate', config: { groupBy: null, metric: null, operation: 'count' } }),
    ]) } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends a bearer token only when configured', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'remote-model', apiKey: 'secret-token', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, workflowExecution: unavailableWorkflowExecution,
      dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_invalid_response', status: 502 })
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
  })

  it('rejects a response that is not valid structured JSON', async () => {
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 }))
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, workflowExecution: unavailableWorkflowExecution,
      dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_invalid_response', status: 502 })
  })

  it('reports an explicit error when a reasoning model consumes the output budget before emitting JSON', async () => {
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'reasoning-model', timeoutMs: 5_000, maxTokens: 256, contextWindowTokens: 32_768 }, async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200 }))
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, workflowExecution: unavailableWorkflowExecution,
      dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_provider_output_limit', status: 502 })
  })

  it('drops oldest history to reserve input and output space within the configured context window', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'clarification', message: '確認します。', changes: [], questions: [{ id: 'q', prompt: '期間は？', choices: [] }],
      sourceIds: [], limit: 0, reason: '', ...unusedToolFields,
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'small-context', timeoutMs: 5_000, maxTokens: 1_024, contextWindowTokens: 8_192 }, fetchMock)
    await provider.respond({ message: 'test', workflow: sampleWorkflow, workflowExecution: unavailableWorkflowExecution,
      dataSources: [], catalogs: [],
      history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(1_000) })) })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages.length).toBeLessThan(22)
    const applicationContextIndex = body.messages.findIndex((message) => message.content.includes('現在のアプリケーション状態'))
    const retainedHistory = body.messages.slice(1, applicationContextIndex)
    expect(retainedHistory[0]?.role ?? 'user').toBe('user')
    expect(retainedHistory.every((message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant'))).toBe(true)
  })

  it('rejects an oversized fixed context before sending it to the model API', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'small-context', timeoutMs: 5_000, maxTokens: 1_024, contextWindowTokens: 4_096 }, fetchMock)
    await expect(provider.respond({ message: '売'.repeat(20_000), workflow: sampleWorkflow,
      workflowExecution: unavailableWorkflowExecution, dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_context_limit', status: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
