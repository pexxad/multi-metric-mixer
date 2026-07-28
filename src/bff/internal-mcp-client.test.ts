import { describe, expect, it, vi } from 'vitest'
import { InternalMcpClient } from './internal-mcp-client'
import type { RequestContext } from '../shared/request-context'
import { BackendAccessTokenIssuer, BackendAccessTokenVerifier, bearerToken } from '../shared/backend-access-token'
import { testBackendAccessTokenKeys } from '../test-support'

describe('InternalMcpClient', () => {
  it('issues a unique child request ID for every MCP call under one BFF request', async () => {
    const issued: string[] = []
    const keys = testBackendAccessTokenKeys()
    const realIssuer = new BackendAccessTokenIssuer({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
      keyId: 'test-1', privateKeyBase64: keys.privateKeyBase64, ttlSeconds: 15 })
    const accessTokens = { issue: vi.fn((context: RequestContext, scopes: string[]) => {
      issued.push(context.requestId)
      return realIssuer.issue(context, scopes)
    }) }
    const verifier = new BackendAccessTokenVerifier({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
      keyId: 'test-1', publicKeyBase64: keys.publicKeyBase64 })
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string }
      const headers = new Headers(init?.headers)
      await verifier.verify(bearerToken(headers.get('Authorization') ?? undefined), ['backend:mcp'],
        headers.get('X-Request-Id') ?? '')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } }), { status: 200 })
    })
    const client = new InternalMcpClient({ url: new URL('http://127.0.0.1:3001/mcp'), origin: 'http://127.0.0.1:3000',
      accessTokens: accessTokens as never, fetch: fetchMock })
    const context = { requestId: 'req-parent', sessionHash: 'session', principal: { id: 'principal', displayName: 'Alice', status: 'active' as const },
      workspace: { id: 'workspace', name: 'Main', slug: 'main', role: 'editor' as const, membershipVersion: 1 },
      applicationRole: 'user' as const, assuranceLevel: 'basic' as const }
    await client.call(context, 'data_source_read', { source: 'sales' })
    await client.call(context, 'artifact_preview', { artifactId: 'artifact' })
    expect(issued).toHaveLength(2)
    expect(new Set(issued).size).toBe(2)
    expect(issued.every((id) => id.startsWith('req-parent.'))).toBe(true)
  })

  it('surfaces MCP tool execution errors instead of parsing them as successful data', async () => {
    const keys = testBackendAccessTokenKeys()
    const client = new InternalMcpClient({
      url: new URL('http://127.0.0.1:3001/mcp'),
      origin: 'http://127.0.0.1:3000',
      accessTokens: new BackendAccessTokenIssuer({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
        keyId: 'test-1', privateKeyBase64: keys.privateKeyBase64, ttlSeconds: 15 }),
      fetch: vi.fn(async () => new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 'request',
        result: { isError: true, content: [{ type: 'text', text: 'source_not_found: 対象を確認してください。' }] },
      }), { status: 200 })),
    })
    const context = { requestId: 'req-parent', sessionHash: 'session', principal: { id: 'principal', displayName: 'Alice', status: 'active' as const },
      workspace: { id: 'workspace', name: 'Main', slug: 'main', role: 'editor' as const, membershipVersion: 1 },
      applicationRole: 'user' as const, assuranceLevel: 'basic' as const }

    await expect(client.call(context, 'catalog_describe', { sourceId: 'missing' }))
      .rejects.toMatchObject({ code: 'mcp_tool_error', message: 'source_not_found: 対象を確認してください。' })
  })
})
