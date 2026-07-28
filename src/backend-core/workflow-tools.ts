import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { ArtifactRepository, StoredArtifact } from './persistence/artifact-repository'
import { aggregateOutputColumn, type AggregateStep, type CsvStep, type DeriveStep, type FilterSelectStep, type JoinAggregateStep, type JoinStep, type JsonValue,
  ParseDocumentsStep, PreviewStep, SortLimitStep, TableRow } from '../shared/workflow'

export class WorkflowTools {
  constructor(private readonly artifacts: ArtifactRepository, private readonly maxJoinRows = 100_000) {}

  summary(artifact: StoredArtifact) {
    return this.artifacts.summary(artifact)
  }

  async parseDocuments(context: RequestContext, artifactId: string, config: ParseDocumentsStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireDocuments(context, artifactId)
    const records = selectRecords(input.documents, config.recordPath)
    const rows: TableRow[] = []
    for (const record of records) {
      const row: TableRow = {}
      let skip = false
      for (const column of config.columns) {
        const value = readDocumentPath(record, column.path)
        if (value === MISSING) {
          if (config.onMissing === 'error') throw new AppError('document_field_missing', 400, `JSONパス「${column.path}」がありません。`)
          if (config.onMissing === 'skip') { skip = true; break }
          row[column.name] = null
          continue
        }
        const converted = convertDocumentValue(value, column.dataType)
        if (converted === MISMATCH) {
          if (config.onTypeMismatch === 'error') {
            throw new AppError('document_type_mismatch', 400, `JSONパス「${column.path}」を${column.dataType}へ変換できません。`)
          }
          if (config.onTypeMismatch === 'skip') { skip = true; break }
          row[column.name] = null
        } else row[column.name] = converted
      }
      if (!skip) rows.push(row)
    }
    return this.artifacts.createTable(context, `${input.name}-parsed`, rows, [
      ...input.provenance,
      `parse:record=${config.recordPath}`,
      `parse:columns=${config.columns.map((column) => `${column.name}<-${column.path}:${column.dataType}`).join(',')}`,
      `parse:onMissing=${config.onMissing}`,
      `parse:onTypeMismatch=${config.onTypeMismatch}`,
    ], { runId, classification: input.classification })
  }

  async filterSelect(context: RequestContext, artifactId: string, config: FilterSelectStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireTable(context, artifactId)
    const rows = input.rows.filter((row) => config.filters.every((filter) => matchesFilter(readField(row, filter.field), filter.operator, filter.value)))
      .map((row) => config.columns.length === 0 ? row : Object.fromEntries(config.columns.map((field) => [field, readField(row, field)])))
    return this.artifacts.createTable(context, `${input.name}-filtered`, rows,
      [...input.provenance, `filter:${config.filters.length}`, `select:${config.columns.join(',') || '*'}`],
      { runId, classification: input.classification })
  }

  async derive(context: RequestContext, artifactId: string, config: DeriveStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireTable(context, artifactId)
    const rows = input.rows.map((row) => ({ ...row, [config.output]: deriveValue(row, config) }))
    return this.artifacts.createTable(context, `${input.name}-derived`, rows,
      [...input.provenance, `derive:${config.output}/${config.operation}/${config.source}`],
      { runId, classification: input.classification })
  }

  async join(context: RequestContext, leftArtifactId: string, rightArtifactId: string, config: JoinStep['config'], runId?: string): Promise<StoredArtifact> {
    const left = await this.artifacts.requireTable(context, leftArtifactId)
    const right = await this.artifacts.requireTable(context, rightArtifactId)
    const rightByKey = new Map<string, TableRow[]>()
    for (const row of right.rows) {
      const value = readField(row, config.rightKey)
      const matches = rightByKey.get(joinKey(value)) ?? []
      matches.push(row); rightByKey.set(joinKey(value), matches)
    }
    const rows: TableRow[] = []
    for (const leftRow of left.rows) {
      const matches = rightByKey.get(joinKey(readField(leftRow, config.leftKey))) ?? []
      if (matches.length === 0 && config.joinType === 'left') {
        enforceJoinLimit(rows.length + 1, this.maxJoinRows)
        rows.push({ ...leftRow })
      }
      for (const rightRow of matches) {
        enforceJoinLimit(rows.length + 1, this.maxJoinRows)
        rows.push(mergeRows(leftRow, rightRow))
      }
    }
    const classification = combinedClassification(left.classification, right.classification)
    return this.artifacts.createTable(context, `${left.name}-${config.joinType}-join-${right.name}`, rows,
      [...left.provenance, ...right.provenance, `join:${config.joinType}/${config.leftKey}=${config.rightKey}`, `join:rows=${rows.length}`],
      { runId, classification })
  }

  async sortLimit(context: RequestContext, artifactId: string, config: SortLimitStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireTable(context, artifactId)
    const direction = config.direction === 'asc' ? 1 : -1
    const rows = input.rows.map((row, index) => ({ row, index })).sort((left, right) => {
      const compared = compareValues(readField(left.row, config.sortBy), readField(right.row, config.sortBy))
      return compared === 0 ? left.index - right.index : compared * direction
    }).slice(0, config.limit).map(({ row }) => row)
    return this.artifacts.createTable(context, `${input.name}-sorted`, rows,
      [...input.provenance, `sort:${config.sortBy}/${config.direction}`, `limit:${config.limit}`],
      { runId, classification: input.classification })
  }

  async aggregate(context: RequestContext, artifactId: string, config: AggregateStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireTable(context, artifactId)
    const buckets = new Map<string, AggregateBucket>()
    if (!config.groupBy) buckets.set('all', emptyAggregateBucket(null))
    for (const row of input.rows) {
      const label = config.groupBy ? readField(row, config.groupBy) : null
      const metricValue = config.metric ? readField(row, config.metric) : null
      const key = config.groupBy ? joinKey(label) : 'all'
      const current = buckets.get(key) ?? emptyAggregateBucket(label)
      if (config.operation !== 'count') addMetric(current, metricValue, config.metric!)
      current.count += 1
      buckets.set(key, current)
    }
    const outputColumn = aggregateOutputColumn(config)
    const rows = [...buckets.values()].sort((a, b) => String(a.label).localeCompare(String(b.label), 'ja')).map((bucket) =>
      config.groupBy
        ? { [config.groupBy]: bucket.label, [outputColumn]: aggregateBucketValue(config.operation, bucket) }
        : { [outputColumn]: aggregateBucketValue(config.operation, bucket) })
    const grouping = config.groupBy ?? 'all'
    return this.artifacts.createTable(context, `${grouping}-${outputColumn}`, rows,
      [...input.provenance, `aggregate:${grouping}/${config.operation}/${config.metric ?? 'rows'}`], { runId, classification: input.classification })
  }

  async joinAggregate(
    context: RequestContext,
    leftArtifactId: string,
    rightArtifactId: string,
    config: JoinAggregateStep['config'],
    runId?: string,
  ): Promise<StoredArtifact> {
    const left = await this.artifacts.requireTable(context, leftArtifactId)
    const right = await this.artifacts.requireTable(context, rightArtifactId)
    const rightByKey = new Map<string, TableRow[]>()
    for (const row of right.rows) {
      const key = joinKey(readField(row, config.rightKey))
      const matches = rightByKey.get(key) ?? []
      matches.push(row)
      rightByKey.set(key, matches)
    }
    const buckets = new Map<string, AggregateBucket>()
    let joinedRows = 0
    for (const row of left.rows) {
      const metric = readField(row, config.metric)
      if (typeof metric !== 'number' || !Number.isFinite(metric)) throw new AppError('join_metric_invalid', 400, `左入力の指標列「${config.metric}」は有限の数値ではありません。`)
      for (const match of rightByKey.get(joinKey(readField(row, config.leftKey))) ?? []) {
        joinedRows += 1
        if (joinedRows > this.maxJoinRows) throw new AppError('join_cardinality_limit', 413, `結合結果が上限${this.maxJoinRows}行を超えました。`)
        const label = readField(match, config.groupBy)
        const key = joinKey(label)
        const bucket = buckets.get(key) ?? emptyAggregateBucket(label)
        bucket.total += metric
        bucket.count += 1
        buckets.set(key, bucket)
      }
    }
    const rows = [...buckets.values()].map((bucket) => ({
      [config.groupBy]: bucket.label,
      [`${config.operation}_${config.metric}`]: aggregateBucketValue(config.operation, bucket),
    }))
    const classification = combinedClassification(left.classification, right.classification)
    return this.artifacts.createTable(context, `${config.groupBy}-${config.operation}-${config.metric}`, rows, [
      ...left.provenance, ...right.provenance,
      `join:${config.leftKey}=${config.rightKey}`, `join:rows=${joinedRows}`,
      `aggregate:${config.groupBy}/${config.operation}/${config.metric}`,
    ], { runId, classification })
  }

  async preview(context: RequestContext, artifactId: string, config: PreviewStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.get(context, artifactId)
    if (!input) throw new AppError('artifact_not_found', 404, `成果物「${artifactId}」が見つかりません。`)
    if (input.type === 'documents') {
      const documents = input.documents ?? []
      const preview = documents.length === 1 && Array.isArray(documents[0])
        ? documents[0].slice(0, config.limit)
        : documents.slice(0, config.limit)
      return this.artifacts.createDocuments(context, `${input.name}-preview`, preview,
        [...input.provenance, `preview:limit=${config.limit}`], { runId, classification: input.classification })
    }
    if (input.type !== 'table' || !input.rows) {
      throw new AppError('artifact_type_mismatch', 400, 'CSV成果物はプレビュー処理へ入力できません。')
    }
    return this.artifacts.createTable(context, `${input.name}-preview`, input.rows.slice(0, config.limit),
      [...input.provenance, `preview:limit=${config.limit}`], { runId, classification: input.classification })
  }

  async csv(context: RequestContext, artifactId: string, config: CsvStep['config'], runId?: string): Promise<StoredArtifact> {
    const input = await this.artifacts.requireTable(context, artifactId)
    return this.artifacts.createCsv(context, config.fileName, input.rows,
      [...input.provenance, `export:csv/${config.fileName}`], config.mode, { runId, classification: input.classification })
  }
}

const MISSING = Symbol('missing')
const MISMATCH = Symbol('mismatch')

function pathParts(path: string): string[] {
  const base = path.endsWith('[]') ? path.slice(0, -2) : path
  return base === '$' ? [] : base.slice(2).split('.')
}

function readDocumentPath(value: JsonValue, path: string): JsonValue | typeof MISSING {
  let current = value
  for (const part of pathParts(path)) {
    if (current === null || Array.isArray(current) || typeof current !== 'object' || !(part in current)) return MISSING
    current = current[part]!
  }
  return current
}

function selectRecords(documents: JsonValue[], recordPath: string): JsonValue[] {
  const explode = recordPath.endsWith('[]')
  const records: JsonValue[] = []
  for (const document of documents) {
    const selected = readDocumentPath(document, explode ? recordPath.slice(0, -2) : recordPath)
    if (selected === MISSING) continue
    if (explode) {
      if (!Array.isArray(selected)) throw new AppError('document_record_path_invalid', 400, `レコードパス「${recordPath}」は配列ではありません。`)
      records.push(...selected)
    } else records.push(selected)
  }
  return records
}

function convertDocumentValue(value: JsonValue, type: ParseDocumentsStep['config']['columns'][number]['dataType']): JsonValue | typeof MISMATCH {
  if (value === null || typeof value === 'object') return MISMATCH
  if (type === 'string') return typeof value === 'string' ? value : String(value)
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
    return Number.isFinite(parsed) ? parsed : MISMATCH
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 'false') return value === 'true'
    return MISMATCH
  }
  if (typeof value !== 'string' && typeof value !== 'number') return MISMATCH
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? MISMATCH : date.toISOString()
}

function joinKey(value: TableRow[string]): string {
  return typeof value === 'object' ? JSON.stringify(value) : `${typeof value}:${String(value)}`
}

function readField(row: TableRow, path: string): JsonValue {
  if (path in row) return row[path]!
  let current: JsonValue = row
  for (const part of path.split('.')) {
    if (!current || Array.isArray(current) || typeof current !== 'object' || !(part in current)) {
      throw new AppError('table_field_missing', 400, `列「${path}」がありません。`)
    }
    current = current[part]!
  }
  return current
}

function matchesFilter(actual: JsonValue, operator: FilterSelectStep['config']['filters'][number]['operator'], expected: JsonValue): boolean {
  if (operator === 'isNull') return actual === null
  if (operator === 'isNotNull') return actual !== null
  if (operator === 'eq') return joinKey(actual) === joinKey(expected)
  if (operator === 'ne') return joinKey(actual) !== joinKey(expected)
  if (operator === 'contains') return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
  if ((typeof actual !== 'number' && typeof actual !== 'string') || (typeof expected !== 'number' && typeof expected !== 'string')) return false
  if (typeof actual !== typeof expected) return false
  const compared = typeof actual === 'number' && typeof expected === 'number'
    ? actual - expected
    : String(actual).localeCompare(String(expected), 'ja')
  return operator === 'gt' ? compared > 0 : operator === 'gte' ? compared >= 0 : operator === 'lt' ? compared < 0 : compared <= 0
}

function finiteNumber(value: JsonValue, field: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) throw new AppError('derive_value_invalid', 400, `列「${field}」を有限の数値として扱えません。`)
  return number
}

function deriveValue(row: TableRow, config: DeriveStep['config']): JsonValue {
  const source = readField(row, config.source)
  if (config.operation === 'toString') return source === null ? '' : typeof source === 'object' ? JSON.stringify(source) : String(source)
  if (config.operation === 'toNumber') return finiteNumber(source, config.source)
  if (config.operation === 'year' || config.operation === 'month') {
    if (typeof source !== 'string' && typeof source !== 'number') throw new AppError('derive_date_invalid', 400, `列「${config.source}」を日時として扱えません。`)
    const date = new Date(source)
    if (Number.isNaN(date.getTime())) throw new AppError('derive_date_invalid', 400, `列「${config.source}」を日時として扱えません。`)
    return config.operation === 'year' ? date.getUTCFullYear() : date.getUTCMonth() + 1
  }
  const left = finiteNumber(source, config.source)
  const right = config.operandField ? finiteNumber(readField(row, config.operandField), config.operandField) : config.operandValue
  if (right === null) throw new AppError('derive_operand_missing', 400, '算術演算の右辺が設定されていません。')
  if (config.operation === 'add') return left + right
  if (config.operation === 'subtract') return left - right
  if (config.operation === 'multiply') return left * right
  if (right === 0) throw new AppError('derive_divide_by_zero', 400, '0では除算できません。')
  return left / right
}

function mergeRows(left: TableRow, right: TableRow): TableRow {
  const merged: TableRow = { ...left }
  for (const [key, value] of Object.entries(right)) merged[key in merged ? `right.${key}` : key] = value
  return merged
}

function compareValues(left: JsonValue, right: JsonValue): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(typeof left === 'object' ? JSON.stringify(left) : left).localeCompare(String(typeof right === 'object' ? JSON.stringify(right) : right), 'ja')
}

function combinedClassification(left: StoredArtifact['classification'], right: StoredArtifact['classification']): StoredArtifact['classification'] {
  return left === 'restricted' || right === 'restricted' ? 'restricted'
    : left === 'confidential' || right === 'confidential' ? 'confidential' : 'internal'
}

function enforceJoinLimit(nextRowCount: number, limit: number): void {
  if (nextRowCount > limit) throw new AppError('join_cardinality_limit', 413, `結合結果が上限${limit}行を超えました。`)
}

type AggregateBucket = { label: JsonValue; total: number; count: number; min: number; max: number }

function emptyAggregateBucket(label: JsonValue): AggregateBucket {
  return { label, total: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }
}

function addMetric(bucket: AggregateBucket, value: JsonValue, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('aggregate_metric_invalid', 400, `指標列「${field}」は有限の数値ではありません。`)
  }
  bucket.total += value
  bucket.min = Math.min(bucket.min, value)
  bucket.max = Math.max(bucket.max, value)
}

function aggregateBucketValue(operation: AggregateStep['config']['operation'], bucket: AggregateBucket): number {
  if (operation === 'average') return bucket.total / bucket.count
  if (operation === 'count') return bucket.count
  if (operation === 'min') return bucket.min
  if (operation === 'max') return bucket.max
  return bucket.total
}
