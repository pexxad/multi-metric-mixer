import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../errors'
import type { RequestContext } from '../request-context'
import type { ArtifactSummary, TableRow } from '../../shared/workflow'
import type { ApplicationDatabase } from './database'
import type { ArtifactContentStore } from './artifact-content-store'
import { sql } from 'kysely'

export type StoredArtifact = ArtifactSummary & {
  workspaceId: string
  runId?: string
  rows?: TableRow[]
  content?: Uint8Array
  mimeType?: string
}

type ArtifactMetadata = {
  runId?: string
  classification?: ArtifactSummary['classification']
  expiresAt?: string
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

function formulaRisk(value: string): boolean {
  const trimmed = value.replace(/^[\u0000-\u0020]+/, '')
  const normalized = trimmed.normalize('NFKC')
  return /^[=+\-@]/.test(normalized) || /^[\t\r\n]/.test(value)
}

function csvCell(value: TableRow[string], spreadsheetSafe: boolean): { text: string; neutralized: boolean } {
  const source = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '')
  const neutralized = spreadsheetSafe && formulaRisk(source)
  const text = neutralized ? `'${source}` : source
  return { text: /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text, neutralized }
}

export class ArtifactRepository {
  constructor(private readonly database: ApplicationDatabase, private readonly contentStore: ArtifactContentStore,
    private readonly maxWorkspaceBytes = 1024 * 1024 * 1024, private readonly retentionDays = 30) {}

  createTable(
    context: RequestContext,
    name: string,
    rows: TableRow[],
    provenance: string[],
    metadata: ArtifactMetadata = {},
  ): Promise<StoredArtifact> {
    const serialized = JSON.stringify(rows)
    return this.insert(context, {
      id: `art_${randomUUID()}`,
      workspaceId: context.workspace.id,
      runId: metadata.runId,
      type: 'table',
      name,
      rowCount: rows.length,
      columns: rows[0] ? Object.keys(rows[0]) : [],
      preview: rows.slice(0, 10),
      provenance,
      trustLevel: 'untrusted',
      classification: metadata.classification ?? 'internal',
      checksum: sha256(serialized),
      createdAt: new Date().toISOString(),
      rows,
      content: Buffer.from(serialized),
    }, metadata.expiresAt)
  }

  async createCsv(
    context: RequestContext,
    name: string,
    rows: TableRow[],
    provenance: string[],
    mode: 'spreadsheet' | 'machine',
    metadata: ArtifactMetadata = {},
  ): Promise<StoredArtifact> {
    const columns = rows[0] ? Object.keys(rows[0]) : []
    let neutralized = 0
    const lines = [columns.map((column) => csvCell(column, false).text).join(',')]
    for (const row of rows) {
      lines.push(columns.map((column) => {
        const cell = csvCell(row[column], mode === 'spreadsheet')
        if (cell.neutralized) neutralized += 1
        return cell.text
      }).join(','))
    }
    const text = lines.join('\r\n')
    const content = Buffer.from(`${mode === 'spreadsheet' ? '\uFEFF' : ''}${text}`, 'utf8')
    const artifact = await this.insert(context, {
      id: `art_${randomUUID()}`,
      workspaceId: context.workspace.id,
      runId: metadata.runId,
      type: 'csv',
      name,
      rowCount: rows.length,
      columns,
      provenance: [...provenance, `csv:mode=${mode}`, `csv:neutralized=${neutralized}`],
      trustLevel: 'untrusted',
      classification: metadata.classification ?? 'internal',
      checksum: sha256(content),
      createdAt: new Date().toISOString(),
      content,
      mimeType: 'text/csv; charset=utf-8',
    }, metadata.expiresAt)
    return artifact
  }

  async get(context: RequestContext, id: string): Promise<StoredArtifact | undefined> {
    const row = await this.database.query.selectFrom('artifacts').selectAll().where('id', '=', id)
      .where('workspace_id', '=', context.workspace.id).where((eb) => eb.or([
        eb('expires_at', 'is', null), eb('expires_at', '>', new Date().toISOString()),
      ])).executeTakeFirst() as Record<string, unknown> | undefined
    if (!row) return undefined
    const content = await this.contentStore.get(row.object_key as string)
    const type = row.type as StoredArtifact['type']
    const rows = type === 'table' && content ? JSON.parse(Buffer.from(content).toString('utf8')) as TableRow[] : undefined
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      runId: row.run_id as string | undefined,
      type,
      name: row.name as string,
      rowCount: row.row_count as number,
      columns: JSON.parse(row.columns_json as string) as string[],
      preview: row.preview_json ? JSON.parse(row.preview_json as string) as TableRow[] : undefined,
      provenance: JSON.parse(row.provenance_json as string) as string[],
      trustLevel: 'untrusted',
      classification: row.classification as ArtifactSummary['classification'],
      checksum: row.checksum as string,
      createdAt: row.created_at as string,
      rows,
      content: type === 'csv' ? content : undefined,
      mimeType: row.media_type as string | undefined,
    }
  }

  async requireTable(context: RequestContext, id: string): Promise<StoredArtifact & { rows: TableRow[] }> {
    const artifact = await this.get(context, id)
    if (!artifact?.rows) throw new AppError('artifact_not_found', 404, `テーブル成果物「${id}」が見つかりません。`)
    return artifact as StoredArtifact & { rows: TableRow[] }
  }

  summary(artifact: StoredArtifact): ArtifactSummary {
    const { workspaceId: _workspaceId, runId: _runId, rows: _rows, content: _content, mimeType: _mimeType, ...summary } = artifact
    return summary
  }

  async list(context: RequestContext, limit = 100): Promise<ArtifactSummary[]> {
    const rows = await this.database.query.selectFrom('artifacts').selectAll().where('workspace_id', '=', context.workspace.id)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date().toISOString())]))
      .orderBy('created_at', 'desc').limit(limit).execute() as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, type: row.type as ArtifactSummary['type'], name: row.name as string,
      rowCount: Number(row.row_count), columns: JSON.parse(row.columns_json as string) as string[],
      preview: row.preview_json ? JSON.parse(row.preview_json as string) as TableRow[] : undefined,
      provenance: JSON.parse(row.provenance_json as string) as string[], trustLevel: 'untrusted',
      classification: row.classification as ArtifactSummary['classification'], checksum: row.checksum as string,
      createdAt: row.created_at as string }))
  }

  private async insert(context: RequestContext, artifact: StoredArtifact, expiresAt?: string): Promise<StoredArtifact> {
    if (!artifact.content) throw new Error('artifact_content_required')
    const objectKey = `workspaces/${context.workspace.id}/artifacts/${artifact.id}`
    await this.contentStore.putImmutable(objectKey, artifact.content, artifact.mimeType ?? 'application/json')
    try {
      await this.database.query.transaction().execute(async (db) => {
        if (this.database.driver === 'postgres') await db.selectFrom('workspaces').select('id')
          .where('id', '=', context.workspace.id).forUpdate().executeTakeFirstOrThrow()
        const usage = await db.selectFrom('artifacts').select(sql<number>`coalesce(sum(content_bytes), 0)`.as('bytes'))
          .where('workspace_id', '=', context.workspace.id).executeTakeFirstOrThrow()
        if (Number(usage.bytes) + artifact.content!.byteLength > this.maxWorkspaceBytes) {
          throw new AppError('artifact_storage_quota', 413, 'WorkspaceのArtifact保存容量上限を超えます。')
        }
        await db.insertInto('artifacts').values({ id: artifact.id, workspace_id: context.workspace.id,
          run_id: artifact.runId ?? null, type: artifact.type, name: artifact.name, media_type: artifact.mimeType ?? null,
          row_count: artifact.rowCount, columns_json: JSON.stringify(artifact.columns),
          preview_json: artifact.preview ? JSON.stringify(artifact.preview) : null, object_key: objectKey,
          content_bytes: artifact.content!.byteLength, provenance_json: JSON.stringify(artifact.provenance), trust_level: 'untrusted',
          classification: artifact.classification, checksum: artifact.checksum, created_by: context.principal.id,
          created_at: artifact.createdAt, expires_at: expiresAt ?? new Date(Date.now() + this.retentionDays * 86_400_000).toISOString() }).execute()
      })
    } catch (error) {
      await this.contentStore.delete(objectKey).catch(() => undefined)
      throw error
    }
    return artifact
  }

  async pruneExpired(now = new Date().toISOString()): Promise<number> {
    const expired = await this.database.query.selectFrom('artifacts').select(['id', 'object_key'])
      .where('expires_at', 'is not', null).where('expires_at', '<=', now).execute() as Array<{ id: string; object_key: string }>
    for (const artifact of expired) await this.contentStore.delete(artifact.object_key).catch(() => undefined)
    if (expired.length > 0) await this.database.query.deleteFrom('artifacts').where('id', 'in', expired.map((item) => item.id)).execute()
    return expired.length
  }
}

export const spreadsheetFormulaRisk = formulaRisk
