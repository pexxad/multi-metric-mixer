import { describe, expect, it, vi } from 'vitest'
import { InternalMcpClient } from './internal-mcp-client'
import type { RequestContext } from '../shared/request-context'
import { BackendCapabilityIssuer, BackendCapabilityVerifier, bearerToken } from '../shared/backend-capability'
import { testCapabilityKeys } from '../test-support'
import { contentHash } from '../shared/canonical-hash'

describe('InternalMcpClient', () => {
  it('issues a unique child request ID for every MCP call under one BFF request', async () => {
    const issued: string[] = []
    const keys = testCapabilityKeys()
    const realIssuer = new BackendCapabilityIssuer({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
      keyId: 'test-1', privateKeyBase64: keys.privateKeyBase64, ttlSeconds: 15 })
    const capabilities = { issue: vi.fn((context: RequestContext, request) => {
      issued.push(context.requestId)
      return realIssuer.issue(context, request)
    }) }
    const verifier = new BackendCapabilityVerifier({ issuer: 'test-bff', audience: 'http://127.0.0.1:3001',
      keyId: 'test-1', publicKeyBase64: keys.publicKeyBase64 })
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: string; params: { name: string } }
      verifier.verify(bearerToken(new Headers(init?.headers).get('Authorization') ?? undefined), {
        action: body.params.name, inputHash: contentHash(body), scopes: ['backend:mcp', `tool:${body.params.name}`],
      })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } }), { status: 200 })
    })
    const client = new InternalMcpClient({ url: new URL('http://127.0.0.1:3001/mcp'), origin: 'http://127.0.0.1:3000',
      capabilities: capabilities as never, fetch: fetchMock })
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
