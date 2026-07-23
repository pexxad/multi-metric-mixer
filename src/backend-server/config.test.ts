import { describe, expect, it } from 'vitest'
import { loadBackendRuntimeConfig } from './config'
import { testCapabilityKeys } from '../test-support'

const keys = testCapabilityKeys()
describe('Backend process configuration boundary', () => {
  it('starts from Backend-only settings and never requires or exposes OIDC/session secrets', () => {
    const config = loadBackendRuntimeConfig({ PORT: '3000', BACKEND_PORT: '3001', BACKEND_TOKEN_PUBLIC_KEY_BASE64: keys.publicKeyBase64 })
    expect(config.backendServer).toMatchObject({ hostname: '127.0.0.1', port: 3001 })
    expect(config).not.toHaveProperty('auth')
    expect(config).not.toHaveProperty('publicServer')
  })

  it('fails closed when asked to bind through any non-loopback host value', () => {
    const config = loadBackendRuntimeConfig({ BACKEND_HOST: '0.0.0.0', BACKEND_TOKEN_PUBLIC_KEY_BASE64: keys.publicKeyBase64 })
    expect(config.backendServer.hostname).toBe('127.0.0.1')
  })

  it('requires AWS Secrets Manager for the cloud persistence profile', () => {
    expect(() => loadBackendRuntimeConfig({ BACKEND_STORAGE_DRIVER: 'postgres', BACKEND_DATABASE_URL_SECRET_ID: 'database', AWS_REGION: 'ap-northeast-1',
      BACKEND_TOKEN_PUBLIC_KEY_BASE64: keys.publicKeyBase64,
      ARTIFACT_BUCKET: 'artifacts', ARTIFACT_PREFIX: 'production', ARTIFACT_KMS_KEY_ID: 'key' })).toThrow('DATA_SOURCE_SECRET_PROVIDER')
  })
})
