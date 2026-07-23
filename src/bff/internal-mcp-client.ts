import { randomUUID } from 'node:crypto'
import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { BackendCapabilityIssuer } from '../shared/backend-capability'
import { contentHash } from '../shared/canonical-hash'

type InternalMcpClientOptions = {
  url: URL
  origin: string
  capabilities: BackendCapabilityIssuer
  fetch?: typeof fetch
}

function responsePayload(text: string): unknown {
  const event = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
  const parsed = JSON.parse(event ?? text) as { result?: { structuredContent?: unknown; content?: Array<{ text?: string }> }; error?: { message?: string } }
  if (parsed.error) throw new AppError('mcp_protocol_error', 502, parsed.error.message ?? 'MCP tool callに失敗しました。')
  if (parsed.result?.structuredContent !== undefined) return parsed.result.structuredContent
  const fallback = parsed.result?.content?.[0]?.text
  return fallback ? JSON.parse(fallback) : undefined
}

export class InternalMcpClient {
  private readonly fetcher: typeof fetch
  constructor(private readonly options: InternalMcpClientOptions) { this.fetcher = options.fetch ?? fetch }

  async health(): Promise<boolean> {
    try {
      const url = new URL('/health', this.options.url)
      const response = await this.fetcher(url, { headers: { Host: url.host, Origin: this.options.origin }, signal: AbortSignal.timeout(2_000) })
      return response.ok
    } catch { return false }
  }

  async call<T>(context: RequestContext, tool: string, input: Record<string, unknown>, workflowContentHash?: string, approvalId?: string): Promise<T> {
    const invocationContext = { ...context, requestId: `${context.requestId}.${randomUUID()}` }
    const body = { jsonrpc: '2.0', id: invocationContext.requestId, method: 'tools/call', params: { name: tool, arguments: input } }
    const capability = this.options.capabilities.issue(invocationContext, {
      action: tool,
      inputHash: contentHash(body),
      scopes: ['backend:mcp', `tool:${tool}`],
      workflowContentHash,
      approvalId,
    })
    const response = await this.fetcher(this.options.url, {
      method: 'POST',
      headers: {
        Host: this.options.url.host,
        Origin: this.options.origin,
        Authorization: `Bearer ${capability}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(workflowContentHash ? { 'X-Workflow-Content-Hash': workflowContentHash } : {}),
        ...(approvalId ? { 'X-Approval-Id': approvalId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new AppError('mcp_internal_request_failed', 502, `内部MCPがHTTP ${response.status}を返しました。`)
    return responsePayload(text) as T
  }
}
