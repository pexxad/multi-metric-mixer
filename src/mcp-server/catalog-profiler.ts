import { createHash } from 'node:crypto'
import type { CatalogDataType, CatalogField, CatalogObservation } from '../shared/catalog'
import type { JsonValue, TableRow } from '../shared/workflow'

type FieldStats = { types: Set<CatalogDataType>; rows: Set<number>; nullSeen: boolean }

function compareTypes(left: CatalogDataType, right: CatalogDataType): number {
  if (left === 'null') return right === 'null' ? 0 : 1
  if (right === 'null') return -1
  return left.localeCompare(right)
}

function valueType(value: JsonValue): CatalogDataType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value as 'string' | 'number' | 'boolean' | 'object'
}

function inspectValue(value: JsonValue, path: string, rowIndex: number, fields: Map<string, FieldStats>, depth: number) {
  if (!path || fields.size >= 500) return
  const stats = fields.get(path) ?? { types: new Set<CatalogDataType>(), rows: new Set<number>(), nullSeen: false }
  const type = valueType(value)
  stats.types.add(type); stats.rows.add(rowIndex); stats.nullSeen ||= value === null
  fields.set(path, stats)
  if (depth >= 8 || value === null) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) inspectValue(item, `${path}[]`, rowIndex, fields, depth + 1)
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 100)) inspectValue(item, `${path}.${key}`, rowIndex, fields, depth + 1)
  }
}

export function profileCatalogRows(sourceId: string, rows: TableRow[], rowCount: number, observedAt = new Date().toISOString()): CatalogObservation {
  const sample = rows.slice(0, 100)
  const stats = new Map<string, FieldStats>()
  sample.forEach((row, rowIndex) => Object.entries(row).forEach(([path, value]) => inspectValue(value, path, rowIndex, stats, 0)))
  const fields: CatalogField[] = [...stats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({
    path,
    dataTypes: [...value.types].sort(compareTypes),
    nullable: value.nullSeen || value.rows.size < sample.length,
    presence: sample.length === 0 ? 0 : value.rows.size / sample.length,
    businessName: '', description: '', unit: '', timezone: '', firstSeenAt: observedAt, lastSeenAt: observedAt,
  }))
  const schemaFingerprint = createHash('sha256')
    .update(JSON.stringify(fields.map(({ path, dataTypes, nullable }) => ({ path, dataTypes, nullable })))).digest('hex')
  return { sourceId, observedAt, rowCount, sampledRows: sample.length, schemaFingerprint, fields }
}
