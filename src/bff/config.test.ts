import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from './config'

const base = {
  AUTH_PROVIDER_KEY: 'oidc-main',
  SESSION_SECRET: 'session-secret-that-is-at-least-32-characters',
  AUTH_TRANSACTION_SECRET: 'transaction-secret-that-is-at-least-32-characters',
  OIDC_ISSUER: 'https://id.example.com',
  OIDC_CLIENT_ID: 'multi-metric-mixer',
  OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback',
}

describe('runtime config', () => {
  it('requires an explicitly selected authentication provider', () => {
    expect(() => loadRuntimeConfig({})).toThrow('AUTH_PROVIDER_KEY is required')
  })

  it('separates public and MCP listeners and fixes MCP to IPv4 loopback', () => {
    const config = loadRuntimeConfig(base)
    expect(config.publicServer.port).toBe(3000)
    expect(config.mcpServer).toMatchObject({ hostname: '127.0.0.1', port: 3001, grantTtlSeconds: 30 })
  })

  it('rejects a shared public and MCP port', () => {
    expect(() => loadRuntimeConfig({ ...base, PORT: '3000', MCP_PORT: '3000' })).toThrow('must be different')
  })

  it('rejects origin values that are not exact origins', () => {
    expect(() => loadRuntimeConfig({ ...base, PUBLIC_ORIGIN: 'https://app.example.com/path' })).toThrow('exact origin')
    expect(() => loadRuntimeConfig({ ...base, ALLOWED_ORIGINS: '*' })).toThrow()
  })

  it('fails closed when PostgreSQL secret configuration is missing', () => {
    expect(() => loadRuntimeConfig({ ...base, STORAGE_DRIVER: 'postgres' })).toThrow()
  })

  it('allows insecure OIDC transport only through an explicit loopback provider policy', () => {
    const local = loadRuntimeConfig({ ...base, OIDC_ISSUER: 'http://127.0.0.1:8080/realms/local', OIDC_ALLOW_HTTP_LOOPBACK: 'true',
      OIDC_LOGOUT_USE_ID_TOKEN_HINT: 'false' })
    expect(local.auth.oidc.allowInsecureLoopback).toBe(true)
    expect(local.auth.oidc.logout).toEqual({ mode: 'oidc', useIdTokenHint: false })
    expect(() => loadRuntimeConfig({ ...base, OIDC_LOGOUT_USE_ID_TOKEN_HINT: 'sometimes' })).toThrow('true or false')
  })

  it('requires an explicit HTTPS endpoint for Cognito managed-login logout', () => {
    expect(() => loadRuntimeConfig({ ...base, OIDC_LOGOUT_MODE: 'cognito' })).toThrow('OIDC_LOGOUT_ENDPOINT')
    expect(() => loadRuntimeConfig({ ...base, OIDC_LOGOUT_MODE: 'cognito', OIDC_LOGOUT_ENDPOINT: 'http://id.example.com/logout' })).toThrow('HTTPS')
    const cognito = loadRuntimeConfig({ ...base, OIDC_LOGOUT_MODE: 'cognito',
      OIDC_LOGOUT_ENDPOINT: 'https://example.auth.ap-northeast-1.amazoncognito.com/logout' })
    expect(cognito.auth.oidc.logout).toEqual({ mode: 'cognito', endpoint: 'https://example.auth.ap-northeast-1.amazoncognito.com/logout' })
  })

  it('configures an OpenAI-compatible API only through an explicit loopback or HTTPS endpoint', () => {
    const local = loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model' })
    expect(local.agent).toMatchObject({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model', timeoutMs: 60_000, maxTokens: 8_192, contextWindowTokens: 32_768 })
    expect(loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'https://models.example.com/v1', OPENAI_COMPATIBLE_MODEL: 'remote-model',
      OPENAI_COMPATIBLE_TIMEOUT_MS: '300000', OPENAI_COMPATIBLE_MAX_TOKENS: '16384',
      OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS: '65536' }).agent)
      .toMatchObject({ timeoutMs: 300_000, maxTokens: 16_384, contextWindowTokens: 65_536 })
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.10:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model' }))
      .toThrow('explicitly approved private IPv4 HTTP')
    expect(loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.10:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model',
      OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP: 'true' }).agent)
      .toMatchObject({ provider: 'openai-compatible', transportSecurity: 'private-http' })
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://models.internal:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model',
      OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP: 'true' })).toThrow('private IPv4 HTTP')
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://203.0.113.10:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model',
      OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP: 'true' })).toThrow('private IPv4 HTTP')
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.10:1234/v1', OPENAI_COMPATIBLE_MODEL: 'local-model',
      OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP: 'yes' })).toThrow('true or false')
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible' })).toThrow('OPENAI_COMPATIBLE_BASE_URL')
    expect(() => loadRuntimeConfig({ ...base, AGENT_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'https://models.example.com/v1', OPENAI_COMPATIBLE_MODEL: 'remote-model',
      OPENAI_COMPATIBLE_MAX_TOKENS: '4096', OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS: '4096' }))
      .toThrow('must leave at least 1024 tokens')
  })
})
