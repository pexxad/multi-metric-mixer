import { AppError } from '../shared/errors'
import type { JsonValue, TableRow } from '../shared/workflow'

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeJsonToRows(value: JsonValue, maxRows = 5_000): TableRow[] {
  const rows = Array.isArray(value)
    ? (value.every(isJsonRecord) ? value : value.map((item, index) => ({ index, value: item })))
    : (isJsonRecord(value) ? [value] : [{ value }])
  if (rows.length > maxRows) throw new AppError('source_row_limit', 413, `データが最大行数${maxRows}を超えました。`)
  return rows
}

export function validateJsonDepth(value: JsonValue, maxDepth: number): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth > maxDepth) throw new AppError('source_json_too_deep', 413, `JSONのネストが上限${maxDepth}を超えました。`)
    if (Array.isArray(current.value)) for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    else if (current.value && typeof current.value === 'object') for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 })
  }
}
