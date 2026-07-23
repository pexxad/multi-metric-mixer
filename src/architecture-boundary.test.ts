import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname)
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g

function dependencyClosure(entries: string[]): Set<string> {
  const visited = new Set<string>()
  const pending = entries.map((entry) => resolve(root, entry))
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!
      if (!specifier.startsWith('.')) continue
      const base = resolve(dirname(file), specifier)
      const target = extname(base) ? base : `${base}.ts`
      pending.push(target)
    }
  }
  return visited
}

describe('BFF and Backend process dependency boundary', () => {
  it('keeps BFF free of MCP server, connector, aggregation, and MCP SDK implementation imports', () => {
    const files = [...dependencyClosure(['bff/index.ts'])]
    expect(files.some((file) => file.includes('/backend-core/') || file.includes('/backend-server/'))).toBe(false)
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toContain('@modelcontextprotocol/sdk')
    expect(source).not.toContain('DynamoDBClient')
    expect(source).not.toContain('CloudWatchLogsClient')
  })

  it('keeps Backend process free of BFF, Browser UI, OIDC provider, and password/session-cookie handling', () => {
    const files = [...dependencyClosure(['backend-server/index.ts'])]
    expect(files.some((file) => file.includes('/bff/') || file.includes('/client/'))).toBe(false)
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toContain('openid-client')
    expect(source).not.toContain('setCookie(')
    expect(source).not.toContain('OIDC_CLIENT_SECRET')
  })

  it('keeps the MCP adapter dependency graph free of the API-only connection administration service', () => {
    const files = [...dependencyClosure(['backend-server/mcp-adapter.ts'])]
    expect(files.some((file) => file.endsWith('/backend-server/data-source-admin-service.ts'))).toBe(false)
    expect(files.some((file) => file.endsWith('/backend-server/api-adapter.ts'))).toBe(false)
  })
})
