import { AppError } from '../shared/errors'
import type { JsonValue } from '../shared/workflow'

export function validateJsonDepth(value: JsonValue, maxDepth: number): void {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth > maxDepth) throw new AppError('source_json_too_deep', 413, `JSONのネストが上限${maxDepth}を超えました。`)
    if (Array.isArray(current.value)) for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    else if (current.value && typeof current.value === 'object') for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 })
  }
}
