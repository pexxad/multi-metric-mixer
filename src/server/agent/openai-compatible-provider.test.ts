import { describe, expect, it, vi } from 'vitest'
import { sampleWorkflow } from '../../shared/workflow'
import { OpenAiCompatibleAgentModel } from './openai-compatible-provider'
import { parseAgentDecisionWire } from './provider'

describe('OpenAI-compatible agent provider', () => {
  it('supports explanation-only and bounded sample decisions without creating a Workflow', () => {
    expect(parseAgentDecisionWire({ state: 'answer', message: '現在は地域別集計です。', changes: [], questions: [],
      sourceIds: [], limit: 0, reason: 'current workflow explanation' })).toMatchObject({ state: 'answer' })
    expect(parseAgentDecisionWire({ state: 'sample', message: '3件を表示します。', changes: [], questions: [],
      sourceIds: ['sales'], limit: 3, reason: 'format inspection' })).toMatchObject({ state: 'sample', sourceIds: ['sales'], limit: 3 })
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
          changes: modelResponse.changes, questions: [], sourceIds: [], limit: 0, reason: '' }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(modelResponse) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    const response = await provider.respond({ message: '売上を見たい', workflow: sampleWorkflow,
      dataSources: [{ id: 'sales', name: '売上', type: 'sql' }], catalogs: [], history: [] })
    expect(response).toMatchObject({ ...modelResponse, plan: { ...modelResponse.plan,
      steps: expect.arrayContaining([expect.objectContaining({ title: 'データを取得' })]) } })
    expect(response.state === 'proposal' ? response.plan.steps : []).toHaveLength(modelResponse.workflow.steps.length)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://models.example.com/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'local-model', temperature: 0.1, max_tokens: 4_096,
      response_format: { type: 'json_schema', json_schema: { strict: true } } })
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('propertyNames')
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('oneOf')
    expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('maxLength')
    expect(JSON.stringify(body.messages)).not.toContain('connectionString')
  })

  it('puts the latest user request after application context and conversation history', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'answer', message: 'local-salesの項目を説明します。', changes: [], questions: [], sourceIds: [], limit: 0, reason: 'latest request',
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)

    await provider.respond({ message: 'local-salesの内容と利用できる項目を教えてください', workflow: sampleWorkflow,
      dataSources: [{ id: 'local-sales', name: 'Local Sales', type: 'sql' }], catalogs: [],
      history: [{ role: 'user', content: '君ができることは何か教えて' },
        { role: 'assistant', content: '私は分析Workflowを作成できます。' }] })

    const messages = (JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: Array<{ role: string; content: string }> }).messages
    expect(messages.slice(-3, -1)).toEqual([
      { role: 'user', content: '君ができることは何か教えて' },
      { role: 'assistant', content: '私は分析Workflowを作成できます。' },
    ])
    expect(messages.at(-1)).toMatchObject({ role: 'user' })
    expect(messages.at(-1)?.content).toContain('今回回答すべき最新の利用者依頼:')
    expect(messages.at(-1)?.content.endsWith('local-salesの内容と利用できる項目を教えてください')).toBe(true)
    expect(messages.at(-1)?.content).not.toContain('"request"')
  })

  it('retries one invalid Workflow proposal and returns a repaired response', async () => {
    const validWorkflow = { ...sampleWorkflow, steps: sampleWorkflow.steps.map((step) => step.kind === 'query'
      ? { ...step, config: { ...step.config, source: 'sales' } } : step) }
    const decision = { state: 'proposal', message: '計画します。', changes: ['地域別に集計'], questions: [], sourceIds: [], limit: 0, reason: '' }
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
      dataSources: [{ id: 'sales', name: '売上', type: 'sql' }], catalogs: [], history: [] }))
      .resolves.toMatchObject({ state: 'proposal', workflow: validWorkflow })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sends a bearer token only when configured', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'remote-model', apiKey: 'secret-token', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 }, fetchMock)
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_invalid_response', status: 502 })
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
  })

  it('rejects a response that is not valid structured JSON', async () => {
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'local-model', timeoutMs: 5_000, maxTokens: 4_096, contextWindowTokens: 32_768 },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 }))
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_invalid_response', status: 502 })
  })

  it('reports an explicit error when a reasoning model consumes the output budget before emitting JSON', async () => {
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'reasoning-model', timeoutMs: 5_000, maxTokens: 256, contextWindowTokens: 32_768 }, async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200 }))
    await expect(provider.respond({ message: 'test', workflow: sampleWorkflow, dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_provider_output_limit', status: 502 })
  })

  it('drops oldest history to reserve input and output space within the configured context window', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      state: 'clarification', message: '確認します。', changes: [], questions: [{ id: 'q', prompt: '期間は？', choices: [] }],
      sourceIds: [], limit: 0, reason: '',
    }) } }] }), { status: 200 }))
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'small-context', timeoutMs: 5_000, maxTokens: 1_024, contextWindowTokens: 4_096 }, fetchMock)
    await provider.respond({ message: 'test', workflow: sampleWorkflow, dataSources: [], catalogs: [],
      history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(1_000) })) })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: unknown[] }
    expect(body.messages.length).toBeLessThan(22)
  })

  it('rejects an oversized fixed context before sending it to the model API', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const provider = new OpenAiCompatibleAgentModel({ baseUrl: new URL('https://models.example.com/v1/'),
      model: 'small-context', timeoutMs: 5_000, maxTokens: 1_024, contextWindowTokens: 4_096 }, fetchMock)
    await expect(provider.respond({ message: '売'.repeat(20_000), workflow: sampleWorkflow, dataSources: [], catalogs: [], history: [] }))
      .rejects.toMatchObject({ code: 'agent_context_limit', status: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
