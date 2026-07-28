import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadInitialAuth, respondToAgent, type AuthSession } from './api'
import { sampleWorkflow } from '../shared/workflow'

const session: AuthSession = {
  authenticated: true,
  principal: { displayName: 'Alice' },
  workspace: { name: 'Main', role: 'owner' },
  applicationRole: 'user',
  csrfToken: 'csrf',
}

describe('initial authentication request', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('deduplicates concurrent checks so one-time session rotation is not raced', async () => {
    let release!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { release = resolve })
    const fetchMock = vi.fn(() => response)
    vi.stubGlobal('fetch', fetchMock)

    const first = loadInitialAuth()
    const second = loadInitialAuth()
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release(Response.json({ authenticated: false, providers: [] }, { status: 401 }))
    await expect(Promise.all([first, second])).resolves.toEqual([
      { session: null, providers: [] },
      { session: null, providers: [] },
    ])
  })

  it('streams each MCP tool status before returning the final Agent response', async () => {
    const completed = { id: 'call-1', tool: 'catalog_explore_personal', label: '売上を探索', status: 'completed' as const, durationMs: 18 }
    const finalResponse = {
      state: 'answer' as const,
      conversationId: 'conversation-1',
      message: '探索が完了しました。',
      changes: [],
      reason: 'Catalogを確認しました。',
      toolCalls: [completed],
    }
    const body = [
      'event: activity\r\n',
      `data: ${JSON.stringify({ ...completed, status: 'running', durationMs: undefined })}\r\n\r\n`,
      'event: activity\r\n',
      `data: ${JSON.stringify(completed)}\r\n\r\n`,
      'event: response\r\n',
      `data: ${JSON.stringify(finalResponse)}`,
    ].join('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))
    const activities: Array<typeof completed | Omit<typeof completed, 'durationMs'>> = []

    const response = await respondToAgent(session, {
      clientMessageId: 'message-1',
      message: '売上を調べて',
      workflow: sampleWorkflow,
    }, (activity) => activities.push(activity as typeof completed))

    expect(activities).toMatchObject([
      { id: 'call-1', status: 'running' },
      { id: 'call-1', status: 'completed', durationMs: 18 },
    ])
    expect(response).toEqual(finalResponse)
  })
})
