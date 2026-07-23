import { describe, expect, it } from 'vitest'
import { SafeHttpClient, readBoundedBody, safeHttpInternals, type HttpTransport } from './safe-http'

describe('SafeHttpClient', () => {
  const response = (value: unknown, overrides: Partial<Awaited<ReturnType<HttpTransport>>> = {}) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value),
    byteLength: Buffer.byteLength(JSON.stringify(value)),
    ...overrides,
  })

  function client(transport: HttpTransport, overrides: Partial<ConstructorParameters<typeof SafeHttpClient>[0]> = {}) {
    return new SafeHttpClient({
      timeoutMs: 1_000,
      maxResponseBytes: 2_048,
      maxRedirects: 2,
      maxJsonDepth: 8,
      allowedPrivateHosts: ['127.0.0.1'],
      allowedHttpHosts: ['127.0.0.1'],
      transport,
      ...overrides,
    })
  }

  it('allows an explicitly registered local sample destination and parses bounded JSON', async () => {
    const transport: HttpTransport = async () => response({ ok: true, nested: { value: 1 } })
    await expect(client(transport).getJson(new URL('http://127.0.0.1:3100/data'))).resolves.toMatchObject({
      json: { ok: true, nested: { value: 1 } }, redirectCount: 0,
    })
  })

  it('validates every redirect and always denies link-local metadata addresses', async () => {
    const transport: HttpTransport = async () => response({}, { status: 302, location: 'https://169.254.169.254/latest/meta-data/' })
    await expect(client(transport).getJson(new URL('http://127.0.0.1:3100/redirect'))).rejects.toThrow('network range')
  })

  it('blocks private destinations unless the exact hostname is explicitly allowed', async () => {
    const transport: HttpTransport = async () => response({ ok: true })
    await expect(client(transport, { allowedPrivateHosts: [] }).getJson(new URL('http://127.0.0.1/data'))).rejects.toThrow('private')
  })

  it('enforces the response limit while streaming instead of after buffering', async () => {
    async function* chunks() { yield Buffer.alloc(40); yield Buffer.alloc(40) }
    await expect(readBoundedBody(chunks(), 64)).rejects.toThrow('上限64 bytes')
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['169.254.169.254', 'linkLocal'],
    ['::ffff:127.0.0.1', 'loopback'],
  ])('classifies %s as %s', (address, range) => {
    expect(safeHttpInternals.addressRange(address)).toBe(range)
  })

  it('rejects deeply nested JSON independently of byte size', () => {
    expect(() => safeHttpInternals.validateJsonDepth({ a: { b: { c: 1 } } }, 2)).toThrow('ネスト')
  })
})
