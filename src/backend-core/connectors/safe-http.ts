import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { AppError } from '../../shared/errors'
import type { JsonValue } from '../../shared/workflow'
import { validateJsonDepth } from '../untrusted-data'

type ResolvedAddress = { address: string; family: 4 | 6 }
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>

export type SafeHttpClientOptions = {
  timeoutMs: number
  maxResponseBytes: number
  maxRedirects: number
  maxJsonDepth: number
  allowedPrivateHosts?: string[]
  allowedHttpHosts?: string[]
  resolver?: HostResolver
  transport?: HttpTransport
}

type HttpTransportResponse = {
  status: number
  location?: string
  contentType: string
  body: string
  byteLength: number
}

export type HttpTransport = (url: URL, pinned: ResolvedAddress, timeoutMs: number, maxResponseBytes: number) => Promise<HttpTransportResponse>

export type SafeJsonResponse = {
  json: JsonValue
  byteLength: number
  contentType: string
  redirectCount: number
}

const defaultResolver: HostResolver = async (hostname) => {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
}

function addressRange(address: string): string {
  const parsed = ipaddr.parse(address)
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (parsed as ipaddr.IPv6).toIPv4Address().range()
  }
  return parsed.range()
}

function validateResolvedAddress(hostname: string, address: string, allowPrivate: boolean): void {
  let range: string
  try { range = addressRange(address) }
  catch { throw new AppError('source_address_invalid', 400, '接続先のIPアドレスを検証できません。') }
  if (range === 'linkLocal' || range === 'unspecified' || range === 'multicast' || range === 'broadcast' || range === 'reserved') {
    throw new AppError('source_address_denied', 403, `接続先「${hostname}」は許可されていないnetwork rangeです。`)
  }
  if (range !== 'unicast' && !allowPrivate) {
    throw new AppError('source_address_denied', 403, `接続先「${hostname}」のprivate／loopback addressは許可されていません。`)
  }
}

export class SafeHttpClient {
  private readonly privateHosts: Set<string>
  private readonly httpHosts: Set<string>
  private readonly resolver: HostResolver
  private readonly transport: HttpTransport

  constructor(private readonly options: SafeHttpClientOptions) {
    this.privateHosts = new Set((options.allowedPrivateHosts ?? []).map((host) => host.toLowerCase()))
    this.httpHosts = new Set((options.allowedHttpHosts ?? []).map((host) => host.toLowerCase()))
    this.resolver = options.resolver ?? defaultResolver
    this.transport = options.transport ?? requestPinned
  }

  async getJson(input: URL): Promise<SafeJsonResponse> {
    let url = new URL(input)
    for (let redirectCount = 0; redirectCount <= this.options.maxRedirects; redirectCount += 1) {
      this.validateUrl(url)
      const addresses = await this.resolver(url.hostname)
      if (addresses.length === 0) throw new AppError('source_dns_empty', 502, '接続先のDNS応答にIPアドレスがありません。')
      const allowPrivate = this.privateHosts.has(url.hostname.toLowerCase())
      for (const { address } of addresses) validateResolvedAddress(url.hostname, address, allowPrivate)
      const response = await this.transport(url, addresses[0]!, this.options.timeoutMs, this.options.maxResponseBytes)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount === this.options.maxRedirects) throw new AppError('source_redirect_limit', 502, 'REST APIのredirect回数が上限を超えました。')
        if (!response.location) throw new AppError('source_redirect_invalid', 502, 'REST APIのredirect先がありません。')
        url = new URL(response.location, url)
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AppError('source_http_error', 502, `REST APIがHTTP ${response.status}を返しました。`)
      }
      if (!response.contentType.toLowerCase().includes('application/json')) {
        throw new AppError('source_content_type_invalid', 502, 'REST APIのContent-TypeがJSONではありません。')
      }
      let json: JsonValue
      try { json = JSON.parse(response.body) as JsonValue }
      catch { throw new AppError('source_json_invalid', 502, 'REST APIレスポンスをJSONとして解析できません。') }
      validateJsonDepth(json, this.options.maxJsonDepth)
      return { json, byteLength: response.byteLength, contentType: response.contentType, redirectCount }
    }
    throw new AppError('source_redirect_limit', 502, 'REST APIのredirect回数が上限を超えました。')
  }

  private validateUrl(url: URL): void {
    if (url.username || url.password) throw new AppError('source_url_credentials_denied', 400, '接続先URLにcredentialを含められません。')
    const hostname = url.hostname.toLowerCase()
    if (url.protocol === 'http:' && !this.httpHosts.has(hostname)) {
      throw new AppError('source_https_required', 400, 'REST API接続にはHTTPSが必要です。')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new AppError('source_protocol_denied', 400, 'REST API接続はHTTPSだけを利用できます。')
    }
  }

}

export async function readBoundedBody(chunks: AsyncIterable<Uint8Array>, maxResponseBytes: number): Promise<{ body: string; byteLength: number }> {
  const collected: Buffer[] = []
  let byteLength = 0
  for await (const chunk of chunks) {
    byteLength += chunk.byteLength
    if (byteLength > maxResponseBytes) {
      throw new AppError('source_response_too_large', 413, `REST APIレスポンスが上限${maxResponseBytes} bytesを超えました。`)
    }
    collected.push(Buffer.from(chunk))
  }
  return { body: Buffer.concat(collected).toString('utf8'), byteLength }
}

const requestPinned: HttpTransport = (url, pinned, timeoutMs, maxResponseBytes) => new Promise((resolve, reject) => {
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
  const request = requester(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': 'multi-metric-mixer/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
    lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
  }, (response) => {
    void readBoundedBody(response, maxResponseBytes).then(({ body, byteLength }) => resolve({
      status: response.statusCode ?? 502,
      location: response.headers.location,
      contentType: String(response.headers['content-type'] ?? ''),
      body,
      byteLength,
    })).catch((error) => {
      response.destroy()
      reject(error)
    })
  })
  request.on('error', reject)
  request.end()
})

export const safeHttpInternals = { addressRange, validateJsonDepth }
