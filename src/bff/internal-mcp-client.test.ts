import { describe, expect, it, vi } from 'vitest'
import { InternalMcpClient } from './internal-mcp-client'
import type { RequestContext } from '../server/request-context'

describe('InternalMcpClient', () => {
  it('issues a unique child request ID for every MCP call under one BFF request', async () => {
    const issued: string[] = []
    const grants = { issue: vi.fn(async (context: RequestContext) => { issued.push(context.requestId); return `grant-${issued.length}` }) }
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } }), { status: 200 })
    })
    const client = new InternalMcpClient({ url: new URL('http://127.0.0.1:3001/mcp'), origin: 'http://127.0.0.1:3000',
      grants: grants as never, fetch: fetchMock })
    const context = { requestId: 'req-parent', sessionHash: 'session', principal: { id: 'principal', displayName: 'Alice', status: 'active' as const },
      workspace: { id: 'workspace', name: 'Main', slug: 'main', role: 'editor' as const, membershipVersion: 1 },
      applicationRole: 'user' as const, assuranceLevel: 'basic' as const }
    await client.call(context, 'data_source_read', { source: 'sales' })
    await client.call(context, 'artifact_preview', { artifactId: 'artifact' })
    expect(issued).toHaveLength(2)
    expect(new Set(issued).size).toBe(2)
    expect(issued.every((id) => id.startsWith('req-parent.'))).toBe(true)
  })
})
