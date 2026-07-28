import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { ArtifactRepository } from './persistence/artifact-repository'
import type { ArtifactContentStore } from './persistence/artifact-content-store'
import { createHash } from 'node:crypto'
import { parseUploadInWorker } from './upload-parser'

export type UploadLimits = { maxBytes: number; maxRows: number; maxColumns: number; maxFieldChars: number; maxDepth: number;
  maxParseMs: number; maxJsonNodes: number; maxJsonKeys: number }

function safeFilename(value: string | undefined, format: 'json' | 'csv'): string {
  const fallback = `upload.${format}`
  if (!value) return fallback
  const leaf = value.split(/[\\/]/).at(-1)?.normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '_') ?? fallback
  return leaf.slice(0, 128) || fallback
}

function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new AppError('upload_encoding_invalid', 400, 'UTF-8として解釈できないファイルです。') }
}

export class UploadIngestionService {
  constructor(private readonly artifacts: ArtifactRepository, private readonly contentStore: ArtifactContentStore,
    private readonly limits: UploadLimits) {}

  async ingest(context: RequestContext, input: { format: 'json' | 'csv'; filename?: string; contentType: string; bytes: Uint8Array }) {
    const started = performance.now()
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > this.limits.maxBytes) throw new AppError('upload_size_invalid', 413, 'アップロードサイズが空または上限超過です。')
    const expected = input.format === 'json' ? 'application/json' : 'text/csv'
    if (!input.contentType.toLowerCase().startsWith(expected)) throw new AppError('upload_content_type_invalid', 415, `Content-Typeは${expected}である必要があります。`)
    const name = safeFilename(input.filename, input.format)
    if (!name.toLowerCase().endsWith(`.${input.format}`)) throw new AppError('upload_extension_invalid', 415, `拡張子は.${input.format}である必要があります。`)
    const quarantineKey = await this.contentStore.quarantine(input.bytes, expected)
    try {
      const text = decodeUtf8(input.bytes).replace(/^\uFEFF/, '')
      if (input.format === 'json') {
        const first = text.trimStart()[0]
        if (first !== '{' && first !== '[') throw new AppError('upload_signature_invalid', 415, 'JSON signatureを確認できません。')
      } else if (text.includes('\0')) {
        throw new AppError('upload_signature_invalid', 415, 'CSVとして扱えないbinary dataです。')
      }
      const provenance = [
        `upload:${input.format}`, `upload:filename=${name}`, `upload:bytes=${input.bytes.byteLength}`,
        `upload:sha256=${createHash('sha256').update(input.bytes).digest('hex')}`, 'quarantine:validated', 'trust:untrusted',
      ]
      if (input.format === 'json') {
        const documents = await parseUploadInWorker(text, 'json', this.limits)
        if (performance.now() - started > this.limits.maxParseMs + 500) throw new AppError('upload_parse_timeout', 408, 'ファイル解析時間が上限を超えました。')
        return await this.artifacts.createDocuments(context, name, documents, provenance)
      }
      const rows = await parseUploadInWorker(text, 'csv', this.limits)
      if (performance.now() - started > this.limits.maxParseMs + 500) throw new AppError('upload_parse_timeout', 408, 'ファイル解析時間が上限を超えました。')
      return await this.artifacts.createTable(context, name, rows, provenance)
    } finally {
      await this.contentStore.delete(quarantineKey).catch(() => undefined)
    }
  }
}
