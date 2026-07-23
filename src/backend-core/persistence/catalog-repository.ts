import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors'
import { canManageDataSources } from '../../shared/request-context'
import type { RequestContext } from '../../shared/request-context'
import {
  catalogDefinitionSchema,
  catalogObservationSchema,
  type CatalogBundle,
  type CatalogDefinition,
  type CatalogField,
  type CatalogVersion,
} from '../../shared/catalog'
import type { BackendDatabase } from '../../backend-core/persistence/backend-database'
import type { DataSource, DataSourceReader } from './data-source-repository'

const CANONICAL_OWNER = '$canonical'
const classificationRank = { internal: 0, confidential: 1, restricted: 2 } as const

type CatalogRow = {
  id: string
  data_source_id: string
  owner_key: string
  scope: 'canonical' | 'personal'
  version: number
  base_canonical_version: number | null
  definition_json: string
  schema_fingerprint: string
  change_source: CatalogVersion['changeSource']
  created_by: string
  created_at: string
}

const fingerprint = (definition: CatalogDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex')

function rowVersion(row: CatalogRow): CatalogVersion {
  return {
    id: row.id, sourceId: row.data_source_id, scope: row.scope,
    ...(row.scope === 'personal' ? { ownerId: row.owner_key } : {}),
    version: Number(row.version),
    ...(row.base_canonical_version ? { baseCanonicalVersion: Number(row.base_canonical_version) } : {}),
    definition: catalogDefinitionSchema.parse(JSON.parse(row.definition_json)),
    schemaFingerprint: row.schema_fingerprint, changeSource: row.change_source,
    createdBy: row.created_by, createdAt: row.created_at,
  }
}

function defaultPolicy(source: DataSource): CatalogDefinition['policy'] {
  if (source.type === 'sql' || source.type === 'upload-artifact') return 'curated'
  if (source.type === 'dynamodb' || source.type === 'cloudwatch-logs' || source.type === 'mongodb') return 'evolving'
  return 'hybrid'
}

export class CatalogRepository {
  constructor(private readonly database: BackendDatabase, private readonly sources: DataSourceReader) {}

  private async active(context: RequestContext, sourceId: string, ownerKey: string): Promise<CatalogVersion | undefined> {
    const row = await this.database.query.selectFrom('catalog_heads as head')
      .innerJoin('catalog_versions as version', 'version.id', 'head.version_id')
      .select(['version.id', 'version.data_source_id', 'version.owner_key', 'version.scope', 'version.version',
        'version.base_canonical_version', 'version.definition_json', 'version.schema_fingerprint', 'version.change_source',
        'version.created_by', 'version.created_at'])
      .where('head.workspace_id', '=', context.workspace.id).where('head.data_source_id', '=', sourceId)
      .where('head.owner_key', '=', ownerKey).executeTakeFirst() as CatalogRow | undefined
    return row ? rowVersion(row) : undefined
  }

  async bundle(context: RequestContext, sourceId: string): Promise<CatalogBundle> {
    if (!await this.sources.get(context, sourceId)) throw new AppError('source_not_found', 404, 'データソースが見つかりません。')
    const [canonical, personal] = await Promise.all([
      this.active(context, sourceId, CANONICAL_OWNER), this.active(context, sourceId, context.principal.id),
    ])
    return { sourceId, canonical, personal, effective: personal ?? canonical,
      personalOutdated: Boolean(personal && canonical && personal.baseCanonicalVersion !== canonical.version) }
  }

  async listEffective(context: RequestContext): Promise<CatalogVersion[]> {
    const sources = await this.sources.list(context)
    const bundles = await Promise.all(sources.map((source) => this.bundle(context, source.id)))
    return bundles.flatMap((bundle) => bundle.effective ? [bundle.effective] : [])
  }

  async savePersonal(context: RequestContext, sourceId: string, input: unknown, expectedVersion?: number,
    changeSource: CatalogVersion['changeSource'] = 'manual') {
    return this.save(context, sourceId, context.principal.id, 'personal', input, expectedVersion, changeSource)
  }

  async saveCanonical(context: RequestContext, sourceId: string, input: unknown, expectedVersion?: number,
    changeSource: CatalogVersion['changeSource'] = 'manual') {
    if (!canManageDataSources(context)) throw new AppError('catalog_admin_required', 403, '正本Catalogの変更は管理者だけが行えます。')
    return this.save(context, sourceId, CANONICAL_OWNER, 'canonical', input, expectedVersion, changeSource)
  }

  private async save(context: RequestContext, sourceId: string, ownerKey: string, scope: CatalogVersion['scope'], input: unknown,
    expectedVersion: number | undefined, changeSource: CatalogVersion['changeSource']): Promise<CatalogVersion> {
    const source = await this.sources.get(context, sourceId)
    if (!source) throw new AppError('source_not_found', 404, 'データソースが見つかりません。')
    let definition = catalogDefinitionSchema.parse(input)
    if (definition.sourceId !== sourceId) throw new AppError('catalog_source_mismatch', 400, 'CatalogのデータソースIDが一致しません。')
    const canonical = scope === 'personal' ? await this.active(context, sourceId, CANONICAL_OWNER) : undefined
    if (canonical && classificationRank[definition.classification] < classificationRank[canonical.definition.classification]) {
      definition = { ...definition, classification: canonical.definition.classification }
    }
    const now = new Date().toISOString()
    return this.database.query.transaction().execute(async (db) => {
      const head = await db.selectFrom('catalog_heads').select('version_id').where('workspace_id', '=', context.workspace.id)
        .where('data_source_id', '=', sourceId).where('owner_key', '=', ownerKey).executeTakeFirst() as { version_id: string } | undefined
      const current = head ? await db.selectFrom('catalog_versions').selectAll().where('id', '=', head.version_id).executeTakeFirst() as CatalogRow : undefined
      if (expectedVersion !== undefined && Number(current?.version ?? 0) !== expectedVersion) {
        throw new AppError('catalog_version_conflict', 409, 'Catalogが別の操作で更新されています。再読込してください。')
      }
      const schemaFingerprint = fingerprint(definition)
      if (current?.schema_fingerprint === schemaFingerprint) return rowVersion(current)
      const history = await db.selectFrom('catalog_versions').select(db.fn.max<number>('version').as('max_version'))
        .where('workspace_id', '=', context.workspace.id).where('data_source_id', '=', sourceId)
        .where('owner_key', '=', ownerKey).executeTakeFirst()
      const version = Number(history?.max_version ?? 0) + 1
      const id = `cat_${randomUUID()}`
      const row = { id, workspace_id: context.workspace.id, data_source_id: sourceId, owner_key: ownerKey, scope, version,
        base_canonical_version: scope === 'personal' ? canonical?.version ?? null : null,
        definition_json: JSON.stringify(definition), schema_fingerprint: schemaFingerprint, change_source: changeSource,
        created_by: context.principal.id, created_at: now }
      await db.insertInto('catalog_versions').values(row).execute()
      await db.insertInto('catalog_heads').values({ workspace_id: context.workspace.id, data_source_id: sourceId,
        owner_key: ownerKey, version_id: id, updated_at: now }).onConflict((conflict) => conflict
        .columns(['workspace_id', 'data_source_id', 'owner_key']).doUpdateSet({ version_id: id, updated_at: now })).execute()
      return rowVersion(row as CatalogRow)
    })
  }

  async resetPersonal(context: RequestContext, sourceId: string): Promise<CatalogBundle> {
    if (!await this.sources.get(context, sourceId)) throw new AppError('source_not_found', 404, 'データソースが見つかりません。')
    await this.database.query.deleteFrom('catalog_heads').where('workspace_id', '=', context.workspace.id)
      .where('data_source_id', '=', sourceId).where('owner_key', '=', context.principal.id).execute()
    return this.bundle(context, sourceId)
  }

  async promotePersonal(context: RequestContext, sourceId: string, expectedCanonicalVersion?: number): Promise<CatalogVersion> {
    if (!canManageDataSources(context)) throw new AppError('catalog_admin_required', 403, '正本Catalogへの反映は管理者だけが行えます。')
    const personal = await this.active(context, sourceId, context.principal.id)
    if (!personal) throw new AppError('personal_catalog_not_found', 404, '正本へ反映する個人版がありません。')
    return this.saveCanonical(context, sourceId, personal.definition, expectedCanonicalVersion, 'promotion')
  }

  async applyObservation(context: RequestContext, sourceId: string, input: unknown): Promise<CatalogVersion> {
    const observation = catalogObservationSchema.parse(input)
    if (observation.sourceId !== sourceId) throw new AppError('catalog_source_mismatch', 400, '探索結果のデータソースIDが一致しません。')
    const source = await this.sources.get(context, sourceId)
    if (!source) throw new AppError('source_not_found', 404, 'データソースが見つかりません。')
    const bundle = await this.bundle(context, sourceId)
    const previous = bundle.effective?.definition
    const annotations = new Map(previous?.fields.map((field) => [field.path, field]) ?? [])
    const observedPaths = new Set(observation.fields.map((field) => field.path))
    const fields: CatalogField[] = [...observation.fields.map((field): CatalogField => {
      const existing = annotations.get(field.path)
      return { ...field,
        businessName: existing?.businessName ?? '', description: existing?.description ?? '', unit: existing?.unit ?? '',
        timezone: existing?.timezone ?? '', firstSeenAt: existing?.firstSeenAt ?? field.firstSeenAt,
      }
    }), ...(previous?.fields ?? []).filter((field) => !observedPaths.has(field.path)).map((field): CatalogField => ({
      ...field, nullable: true, presence: 0,
    }))].sort((left, right) => left.path.localeCompare(right.path))
    const timeField = previous?.defaultTimeField && fields.some((field) => field.path === previous.defaultTimeField)
      ? previous.defaultTimeField
      : fields.find((field) => /(^|[._])(timestamp|time|date|created_at|updated_at)$/i.test(field.path))?.path ?? null
    const definition: CatalogDefinition = {
      sourceId, displayName: previous?.displayName ?? source.name, description: previous?.description ?? '',
      policy: previous?.policy ?? defaultPolicy(source), classification: previous?.classification ?? 'internal',
      defaultTimeField: timeField, fields, relationships: previous?.relationships ?? [],
    }
    return this.savePersonal(context, sourceId, definition, bundle.personal?.version, 'agent')
  }
}
