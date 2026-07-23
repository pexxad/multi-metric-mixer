import { Worker } from 'node:worker_threads'
import { AppError } from './errors'
import type { TableRow } from '../shared/workflow'
import type { UploadLimits } from './upload-ingestion'

const workerSource = String.raw`
const { parentPort } = require('node:worker_threads')
const { parse } = require('csv-parse/sync')

function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function validateJson(value, limits) {
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const current = pending.pop(); nodes += 1
    if (nodes > limits.maxJsonNodes) fail('upload_json_node_limit', 'JSONの要素数が上限を超えています。')
    if (current.depth > limits.maxDepth) fail('source_json_too_deep', 'JSONのネストが上限を超えています。')
    if (typeof current.value === 'string' && current.value.length > limits.maxFieldChars) fail('upload_field_limit', 'JSON文字列が上限を超えています。')
    if (Array.isArray(current.value)) for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    else if (current.value && typeof current.value === 'object') {
      const entries = Object.entries(current.value)
      if (entries.length > limits.maxJsonKeys) fail('upload_json_key_limit', 'JSON objectのkey数が上限を超えています。')
      for (const [key, item] of entries) {
        if (key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('upload_json_key_invalid', 'JSON keyに許可されない値があります。')
        pending.push({ value: item, depth: current.depth + 1 })
      }
    }
  }
}
function jsonRows(value, maxRows) {
  const record = (item) => item && typeof item === 'object' && !Array.isArray(item)
  const rows = Array.isArray(value) ? (value.every(record) ? value : value.map((item, index) => ({ index, value: item })))
    : record(value) ? [value] : [{ value }]
  if (rows.length > maxRows) fail('upload_row_limit', 'JSON行数が上限を超えています。')
  return rows
}
parentPort.on('message', ({ text, format, limits }) => {
  try {
    let rows
    if (format === 'json') {
      let parsed
      try { parsed = JSON.parse(text) } catch { fail('upload_json_invalid', 'JSONファイルを解析できません。') }
      validateJson(parsed, limits); rows = jsonRows(parsed, limits.maxRows)
    } else {
      let records
      try { records = parse(text, { bom: true, columns: false, relax_column_count: false, skip_empty_lines: true,
        max_record_size: limits.maxFieldChars * limits.maxColumns, to_line: limits.maxRows + 2 }) }
      catch { fail('upload_csv_invalid', 'CSVファイルを安全に解析できません。') }
      if (records.length < 1) fail('upload_csv_empty', 'CSVにheaderがありません。')
      const [headers, ...values] = records
      if (!headers || !headers.length || headers.length > limits.maxColumns || new Set(headers).size !== headers.length)
        fail('upload_csv_header_invalid', 'CSV headerが空、重複、または列数上限超過です。')
      if (headers.some((header) => !header || header.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(header)))
        fail('upload_csv_header_invalid', 'CSV headerに許可されない値があります。')
      if (values.length > limits.maxRows) fail('upload_row_limit', 'CSV行数が上限を超えています。')
      rows = values.map((record) => Object.fromEntries(headers.map((header, index) => {
        const value = record[index] || ''
        if (value.length > limits.maxFieldChars) fail('upload_field_limit', 'CSV fieldが上限を超えています。')
        return [header, value]
      })))
    }
    parentPort.postMessage({ ok: true, rows }); parentPort.close()
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.code || 'upload_parse_failed', message: error.message }); parentPort.close()
  }
})
`

export function parseUploadInWorker(text: string, format: 'json' | 'csv', limits: UploadLimits): Promise<TableRow[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
    let settled = false
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callback() }
    const timer = setTimeout(() => {
      void worker.terminate()
      finish(() => reject(new AppError('upload_parse_timeout', 408, 'ファイル解析時間が上限を超えました。')))
    }, limits.maxParseMs)
    worker.once('message', (result: { ok: boolean; rows?: TableRow[]; code?: string; message?: string }) => finish(() => {
      if (result.ok && result.rows) resolve(result.rows)
      else reject(new AppError(result.code ?? 'upload_parse_failed', 400, result.message ?? 'ファイルを解析できません。'))
    }))
    worker.once('error', () => finish(() => reject(new AppError('upload_memory_limit', 413, 'ファイル解析のメモリ上限を超えました。'))))
    worker.once('exit', (code) => { if (code !== 0) finish(() => reject(new AppError('upload_worker_failed', 400, '隔離されたファイル解析に失敗しました。'))) })
    worker.postMessage({ text, format, limits })
  })
}
