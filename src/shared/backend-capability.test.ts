import { describe, expect, it } from 'vitest'
import { backendContext, testCapabilityKeys } from '../test-support'
import { BackendCapabilityIssuer, BackendCapabilityVerifier } from './backend-capability'

function fixture() {
  const keys = testCapabilityKeys()
  const common = { issuer: 'test-bff', audience: 'http://127.0.0.1:3001', keyId: 'test-1' }
  return {
    issuer: new BackendCapabilityIssuer({
      ...common,
      privateKeyBase64: keys.privateKeyBase64,
      ttlSeconds: 15,
    }),
    verifier: new BackendCapabilityVerifier({
      ...common,
      publicKeyBase64: keys.publicKeyBase64,
    }),
  }
}

describe('BFF to Backend signed capability', () => {
  const request = {
    action: 'data_source_list',
    inputHash: 'a'.repeat(64),
    scopes: ['backend:mcp', 'tool:data_source_list'],
  }

  it('reconstructs the opaque principal and Workspace context without consulting the BFF database', () => {
    const { issuer, verifier } = fixture()
    const context = backendContext()
    const verified = verifier.verify(issuer.issue(context, request), request)
    expect(verified).toMatchObject({
      principal: { id: context.principal.id },
      workspace: { id: context.workspace.id, role: context.workspace.role },
      applicationRole: context.applicationRole,
      capabilityId: expect.any(String),
    })
  })

  it('binds the token to the exact action, input hash, audience, and scope', () => {
    const { issuer, verifier } = fixture()
    const token = issuer.issue(backendContext(), request)
    expect(() => verifier.verify(token, { ...request, action: 'data_source_read' })).toThrow(/一致/)
  })

  it('rejects replay of a one-time capability', () => {
    const { issuer, verifier } = fixture()
    const token = issuer.issue(backendContext(), request)
    verifier.verify(token, request)
    expect(() => verifier.verify(token, request)).toThrow(/すでに使用/)
  })

  it('rejects a token signed by an untrusted BFF key', () => {
    const trusted = fixture()
    const untrusted = fixture()
    const token = untrusted.issuer.issue(backendContext(), request)
    expect(() => trusted.verifier.verify(token, request)).toThrow(/署名/)
  })

  it('normalizes malformed untrusted tokens to a forbidden capability error', () => {
    const { verifier } = fixture()
    expect(() => verifier.verify('not-json.payload.signature', request)).toThrow(/不正/)
  })
})
