import { describe, expect, it } from 'vitest'
import { loadMcpRuntimeConfig } from '../server/config'

describe('MCP process configuration boundary', () => {
  it('starts from MCP-only settings and never requires or exposes OIDC/session secrets', () => {
    const config = loadMcpRuntimeConfig({ PORT: '3000', MCP_PORT: '3001' })
    expect(config.mcpServer).toMatchObject({ hostname: '127.0.0.1', port: 3001 })
    expect(config).not.toHaveProperty('auth')
    expect(config).not.toHaveProperty('publicServer')
  })

  it('fails closed when asked to bind through any non-loopback host value', () => {
    const config = loadMcpRuntimeConfig({ MCP_HOST: '0.0.0.0' })
    expect(config.mcpServer.hostname).toBe('127.0.0.1')
  })

  it('requires AWS Secrets Manager for the cloud persistence profile', () => {
    expect(() => loadMcpRuntimeConfig({ STORAGE_DRIVER: 'postgres', DATABASE_URL_SECRET_ID: 'database', AWS_REGION: 'ap-northeast-1',
      ARTIFACT_BUCKET: 'artifacts', ARTIFACT_PREFIX: 'production', ARTIFACT_KMS_KEY_ID: 'key' })).toThrow('DATA_SOURCE_SECRET_PROVIDER')
  })
})
