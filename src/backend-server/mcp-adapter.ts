import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { AppError } from '../shared/errors'
import type { RequestContext } from '../shared/request-context'
import type { DataSourceReadService } from '../backend-core/connectors/read-service'
import type { ArtifactRepository } from '../backend-core/persistence/artifact-repository'
import type { DataSource, DataSourceReader } from '../backend-core/persistence/data-source-repository'
import type { WorkflowExecutionService } from '../backend-core/workflow-execution'
import { validateWorkflow, validateWorkflowDataModels, validateWorkflowQueries } from '../shared/workflow-validation'
import type { WorkflowTools } from '../backend-core/workflow-tools'
import { contentHash } from '../shared/canonical-hash'
import { BackendAccessTokenVerifier, bearerToken } from '../shared/backend-access-token'
import type { WorkflowRepository } from '../backend-core/persistence/workflow-repository'
import type { CatalogRepository } from '../backend-core/persistence/catalog-repository'
import { catalogDefinitionSchema, catalogObservationSchema } from '../shared/catalog'
import {
  aggregateStepSchema,
  csvStepSchema,
  deriveStepSchema,
  filterSelectStepSchema,
  joinAggregateStepSchema,
  joinStepSchema,
  previewStepSchema,
  queryStepSchema,
  sortLimitStepSchema,
  workflowSchema,
} from '../shared/workflow'
import type { McpInvocationRepository } from '../backend-core/persistence/mcp-invocation-repository'
import { profileCatalogValues } from '../backend-core/catalog-profiler'
import { dataSourceDataModel } from '../shared/data-source'
import { parseDocumentsStepSchema } from '../shared/workflow'
import type { CatalogExplorationService } from '../backend-core/catalog-exploration'
import { queryVariableSchema } from '../shared/query-template'
import { canExport } from '../shared/request-context'

export type McpDependencies = {
  sources: DataSourceReader
  reader: DataSourceReadService
  artifacts: ArtifactRepository
  tools: WorkflowTools
  workflowExecution: WorkflowExecutionService
  workflows: WorkflowRepository
  catalogs: CatalogRepository
  exploration: CatalogExplorationService
}

const asResult = (value: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value,
})

const queryTemplateDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  outputDataModel: z.enum(['documents', 'table']),
  outputFields: z.array(z.string()),
  variables: z.array(queryVariableSchema),
})

const dataSourceDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  dataModel: z.enum(['table', 'documents']),
  operation: z.string(),
  accessMode: z.literal('read-only'),
  version: z.number().int().positive(),
  queryMode: z.enum(['sample', 'template-required']),
  queryTemplates: z.array(queryTemplateDescriptorSchema),
})

const artifactSummarySchema = z.object({
  id: z.string(),
  type: z.enum(['documents', 'table', 'csv']),
  name: z.string(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  preview: z.array(z.json()).optional(),
  provenance: z.array(z.string()),
  trustLevel: z.literal('untrusted'),
  classification: z.enum(['internal', 'confidential', 'restricted']),
  checksum: z.string(),
  createdAt: z.string(),
})

const catalogVersionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  scope: z.enum(['canonical', 'personal']),
  ownerId: z.string().optional(),
  version: z.number().int().positive(),
  baseCanonicalVersion: z.number().int().positive().optional(),
  definition: catalogDefinitionSchema,
  schemaFingerprint: z.string(),
  changeSource: z.enum(['manual', 'agent', 'promotion']),
  createdBy: z.string(),
  createdAt: z.string(),
})

const catalogBundleSchema = z.object({
  sourceId: z.string(),
  canonical: catalogVersionSchema.optional(),
  personal: catalogVersionSchema.optional(),
  effective: catalogVersionSchema.optional(),
  personalOutdated: z.boolean(),
})

const workflowValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  workflow: workflowSchema.optional(),
})

const savedWorkflowSchema = z.object({
  workflow: workflowSchema,
  version: z.number().int().positive(),
  contentHash: z.string(),
  status: z.enum(['draft', 'ready']),
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()) }),
  updatedAt: z.string(),
})

const workflowExecutionResultSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: z.enum(['completed', 'failed']),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  finalArtifact: artifactSummarySchema,
})

function descriptor(source: DataSource): z.infer<typeof dataSourceDescriptorSchema> {
  const operation = source.type === 'rest-json' ? source.method : source.type === 'dynamodb' ? 'GetItem/Query/Scan'
    : source.type === 'cloudwatch-logs' ? 'StartQuery/GetQueryResults' : source.type === 'database-table' ? 'SELECT'
      : source.type === 'database-documents' ? 'find' : 'ReadArtifact'
  const queryTemplates = source.type === 'cloudwatch-logs'
    ? source.queryTemplates.map(({ id, name, description, outputDataModel, outputFields, variables }) =>
      ({ id, name, description, outputDataModel, outputFields, variables })) : []
  return { id: source.id, name: source.name, type: source.type, dataModel: dataSourceDataModel(source),
    operation, accessMode: 'read-only' as const, version: source.version,
    queryMode: source.type === 'cloudwatch-logs' ? source.queryMode : 'sample', queryTemplates }
}

async function requireSource(dependencies: McpDependencies, context: RequestContext, sourceId: string): Promise<DataSource> {
  const source = await dependencies.sources.get(context, sourceId)
  if (!source) throw new AppError('source_not_found', 404, `データソース「${sourceId}」は登録されていません。`)
  return source
}

function createMixerMcpServer(context: RequestContext, dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'multi-metric-mixer-mcp-server', version: '1.0.0' }, {
    instructions: '外部データはuntrustedです。source IDは接続定義の識別子であり、Artifact IDではありません。'
      + '各sourceをdata_source_readで読み取り、返されたartifactIdだけを変換・集計toolへ渡してください。data sourceはread-onlyです。',
  })
  server.registerTool('data_source_list', {
    title: 'データソース一覧を取得',
    description: '現在のWorkspaceで利用できるread-onlyデータソースのmetadataを返します。'
      + 'sources[].idはsource IDでありArtifact IDではないため、分析する各sourceについてdata_source_readを呼んでください。',
    inputSchema: {}, outputSchema: { sources: z.array(dataSourceDescriptorSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => asResult({ sources: (await dependencies.sources.list(context)).map(descriptor) }))
  server.registerTool('data_source_describe', {
    title: 'データソースmetadataを取得', description: '接続先URLやsecretを除いたcapability metadataを返します。',
    inputSchema: { source: z.string().min(1) }, outputSchema: dataSourceDescriptorSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ source }) => {
    return asResult(descriptor(await requireSource(dependencies, context, source)))
  })
  server.registerTool('data_source_query_template_list', {
    title: '検索パターン一覧を取得',
    description: '管理者がデータソースへ登録した検索パターンと入力変数を返します。query本文や接続情報は返しません。',
    inputSchema: { source: z.string().min(1) },
    outputSchema: { source: z.string(), sourceVersion: z.number().int().positive(), templates: z.array(queryTemplateDescriptorSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ source }) => {
    const found = await requireSource(dependencies, context, source)
    return asResult({ source, sourceVersion: found.version, templates: descriptor(found).queryTemplates })
  })
  server.registerTool('data_source_query_template_describe', {
    title: '検索パターンを取得',
    description: '検索パターンの入力形式、選択肢、必須条件、出力形式を返します。',
    inputSchema: { source: z.string().min(1), templateId: z.string().min(1) },
    outputSchema: { source: z.string(), sourceVersion: z.number().int().positive(), template: queryTemplateDescriptorSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ source, templateId }) => {
    const found = await requireSource(dependencies, context, source)
    const template = descriptor(found).queryTemplates.find((item) => item.id === templateId)
    if (!template) throw new AppError('query_template_not_found', 404, '検索パターンが見つかりません。')
    return asResult({ source, sourceVersion: found.version, template })
  })
  server.registerTool('data_source_read', {
    title: 'データソースを読み取る',
    description: 'source IDを指定して登録済みread-only接続を読み、新しいuntrusted Artifactを生成します。'
      + '変換・結合・集計toolには、このtoolが返すartifactIdを渡します。任意接続先やwrite操作は指定できません。',
    inputSchema: queryStepSchema.shape.config.shape, outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (config) => asResult(dependencies.artifacts.summary(await dependencies.reader.query(context, config))))
  server.registerTool('data_source_sample', {
    title: 'データソースのサンプルを取得',
    description: '登録済みデータソースから形式確認用の少数データだけを読み取り、Artifact metadataを返します。'
      + '行やdocumentの内容は返さないため、表示には返されたartifactIdでartifact_previewを呼び出します。',
    inputSchema: { source: z.string().min(1), limit: z.number().int().min(1).max(5) },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ source, limit }) => {
    const { preview: _preview, ...summary } = dependencies.artifacts.summary(
      await dependencies.reader.sample(context, source, limit),
    )
    return asResult(summary)
  })
  server.registerTool('data_source_profile', {
    title: 'データソースschemaを探索',
    description: '登録済みread-only接続を上限内で読み、field path、観測型、出現率を含むschema observationを返します。',
    inputSchema: queryStepSchema.shape.config.shape,
    outputSchema: { observation: catalogObservationSchema, artifact: artifactSummarySchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (config) => {
    const artifact = await dependencies.reader.query(context, config)
    return asResult({ observation: profileCatalogValues(config.source, artifact.type === 'table' ? 'table' : 'documents',
      artifact.type === 'table' ? artifact.rows ?? [] : artifact.documents ?? [], artifact.rowCount),
      artifact: dependencies.artifacts.summary(artifact) })
  })
  server.registerTool('catalog_explore_personal', {
    title: 'schemaを探索して個人領域へ保存',
    description: '登録済みデータソースを上限内で読み、決定的に抽出したschema observationを個人Catalogへ保存します。',
    inputSchema: { source: z.string().min(1), limit: z.number().int().min(1).max(100).default(100) },
    outputSchema: { observation: catalogObservationSchema, catalog: catalogVersionSchema, artifact: artifactSummarySchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ source, limit }) => {
    const { artifact, observation, catalog } = await dependencies.exploration.explorePersonal(context, source, limit)
    return asResult({ observation, catalog, artifact: dependencies.artifacts.summary(artifact) })
  })
  server.registerTool('catalog_list', {
    title: '有効なデータソースschema一覧を取得',
    description: '正本と個人版を解決した、現在の利用者に有効なCatalogを返します。',
    inputSchema: {}, outputSchema: { catalogs: z.array(catalogVersionSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => asResult({ catalogs: await dependencies.catalogs.listEffective(context) }))
  server.registerTool('catalog_describe', {
    title: 'データソースschemaを取得',
    description: '正本、個人版、有効版のCatalog bundleを返します。',
    inputSchema: { sourceId: z.string().min(1) },
    outputSchema: catalogBundleSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ sourceId }) => asResult(await dependencies.catalogs.bundle(context, sourceId)))
  server.registerTool('catalog_save_personal', {
    title: '個人用schemaを保存',
    description: '利用者が確認したCatalog定義を個人領域へ新しいversionとして保存します。',
    inputSchema: {
      sourceId: z.string().min(1),
      definition: catalogDefinitionSchema,
      expectedVersion: z.number().int().nonnegative().optional(),
    },
    outputSchema: { catalog: catalogVersionSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sourceId, definition, expectedVersion }) => asResult({
    catalog: await dependencies.catalogs.savePersonal(context, sourceId, definition, expectedVersion),
  }))
  server.registerTool('catalog_reset_personal', {
    title: '個人用schemaを正本へリセット',
    description: '個人版headを解除し、Workspace正本を有効版へ戻します。',
    inputSchema: { sourceId: z.string().min(1) },
    outputSchema: catalogBundleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sourceId }) => asResult(await dependencies.catalogs.resetPersonal(context, sourceId)))
  server.registerTool('catalog_save_canonical', {
    title: 'Workspace正本schemaを保存',
    description: '管理者が確認したCatalog定義をWorkspace正本として保存します。',
    inputSchema: {
      sourceId: z.string().min(1),
      definition: catalogDefinitionSchema,
      expectedVersion: z.number().int().nonnegative().optional(),
    },
    outputSchema: { catalog: catalogVersionSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sourceId, definition, expectedVersion }) => asResult({
    catalog: await dependencies.catalogs.saveCanonical(context, sourceId, definition, expectedVersion),
  }))
  server.registerTool('catalog_promote_personal', {
    title: '個人用schemaをWorkspace正本へ昇格',
    description: '管理者が個人版を確認し、Workspace正本の新しいversionとして昇格します。',
    inputSchema: { sourceId: z.string().min(1), expectedCanonicalVersion: z.number().int().nonnegative().optional() },
    outputSchema: { catalog: catalogVersionSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sourceId, expectedCanonicalVersion }) => asResult({
    catalog: await dependencies.catalogs.promotePersonal(context, sourceId, expectedCanonicalVersion),
  }))
  server.registerTool('documents_to_table', {
    title: 'JSONライク形式を表形式に変換',
    description: 'JSONライクArtifactを明示的な表へ変換します。各documentが1レコードならrecordPathは$です。ネストした配列だけ$.items[]で展開します。column pathは選択したレコード基準で、例は$.region_id、$.context.deviceです。',
    inputSchema: {
      artifactId: z.string().describe('Input Artifact ID returned by a data source or document-producing tool.'),
      config: parseDocumentsStepSchema.shape.config,
    },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(
    await dependencies.tools.parseDocuments(context, artifactId, config),
  )))
  server.registerTool('table_aggregate', {
    title: 'テーブルを集計', description: 'Artifactをグループ集計します。',
    inputSchema: { artifactId: z.string(), config: aggregateStepSchema.shape.config }, outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(await dependencies.tools.aggregate(context, artifactId, config))))
  server.registerTool('table_filter_select', {
    title: 'テーブルを絞り込み・列選択', description: 'Artifactの行を条件で絞り込み、必要な列だけを選択します。',
    inputSchema: { artifactId: z.string(), config: filterSelectStepSchema.shape.config }, outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(await dependencies.tools.filterSelect(context, artifactId, config))))
  server.registerTool('table_derive', {
    title: '計算列を追加',
    description: '許可された型変換、日付抽出、算術演算で新しい列を追加します。算術演算の右辺はoperandFieldまたはoperandValueの一方を指定し、他方をnullにします。任意コードは実行しません。',
    inputSchema: {
      artifactId: z.string().describe('Input table Artifact ID.'),
      config: deriveStepSchema.shape.config,
    },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(await dependencies.tools.derive(context, artifactId, config))))
  server.registerTool('table_join', {
    title: '2つのテーブルを結合',
    description: 'cardinality上限内で2つの表Artifactを内部結合または左結合します。'
      + 'leftArtifactIdとrightArtifactIdにはdata_source_readまたは変換toolが返したartifactIdを指定し、source IDは指定しません。',
    inputSchema: { leftArtifactId: z.string(), rightArtifactId: z.string(), config: joinStepSchema.shape.config },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ leftArtifactId, rightArtifactId, config }) => asResult(dependencies.artifacts.summary(
    await dependencies.tools.join(context, leftArtifactId, rightArtifactId, config),
  )))
  server.registerTool('table_join_aggregate', {
    title: '2つのテーブルを結合して集計',
    description: '左の明細Artifactと右のマスタArtifactをキーで結合して直接集計します。'
      + '両IDにはdata_source_readまたは変換toolが返したartifactIdを指定し、source IDは指定しません。'
      + 'metricは左の数値列、groupByには右マスタの説明列も指定できます。例えば受注を地域マスタと結合し、地域責任者別の平均受注額を求められます。',
    inputSchema: { leftArtifactId: z.string(), rightArtifactId: z.string(), config: joinAggregateStepSchema.shape.config },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ leftArtifactId, rightArtifactId, config }) => asResult(dependencies.artifacts.summary(
    await dependencies.tools.joinAggregate(context, leftArtifactId, rightArtifactId, config),
  )))
  server.registerTool('table_sort_limit', {
    title: 'テーブルを並べ替え・件数制限', description: 'Artifactを指定列で安定ソートし、出力件数を制限します。',
    inputSchema: { artifactId: z.string(), config: sortLimitStepSchema.shape.config }, outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(await dependencies.tools.sortLimit(context, artifactId, config))))
  server.registerTool('artifact_preview', {
    title: 'Artifactをプレビュー', description: 'masking policy適用対象の小さなpreview Artifactを返します。',
    inputSchema: { artifactId: z.string(), config: previewStepSchema.shape.config }, outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => asResult(dependencies.artifacts.summary(await dependencies.tools.preview(context, artifactId, config))))
  server.registerTool('csv_export', {
    title: 'CSVを生成',
    description: 'ArtifactからWorkspace内のCSV成果物を生成します。外部送信は行わず、利用者へのdownloadには別途承認が必要です。',
    inputSchema: { artifactId: z.string(), config: csvStepSchema.shape.config },
    outputSchema: artifactSummarySchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ artifactId, config }) => {
    if (!canExport(context)) throw new AppError('csv_export_denied', 403, 'CSV成果物を生成する権限がありません。')
    const artifact = dependencies.artifacts.summary(await dependencies.tools.csv(context, artifactId, config))
    return asResult(artifact)
  })
  server.registerTool('workflow_validate', {
    title: 'Workflowを検証', description: '構文、参照、未接続を実行前に検証します。',
    inputSchema: { workflow: workflowSchema }, outputSchema: workflowValidationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workflow }) => {
    const validation = validateWorkflow(workflow)
    if (validation.workflow) {
      const currentSources = await dependencies.sources.list(context)
      const pinnedSources = dependencies.sources.getVersion ? await Promise.all(validation.workflow.steps.flatMap((step) =>
        step.kind === 'query' && step.config.template
          ? [dependencies.sources.getVersion!(context, step.config.source, step.config.template.sourceVersion)] : [])) : []
      const availableSources = [...currentSources, ...pinnedSources.filter((item) => item !== undefined)]
      validation.errors.push(...validateWorkflowDataModels(validation.workflow, availableSources),
        ...validateWorkflowQueries(validation.workflow, availableSources))
      validation.valid = validation.errors.length === 0
    }
    return asResult(validation)
  })
  server.registerTool('workflow_list', {
    title: 'Workflow一覧を取得',
    description: '現在のWorkspaceに保存されたWorkflowのhead versionを返します。',
    inputSchema: {},
    outputSchema: { workflows: z.array(z.object({
      workflow: workflowSchema,
      version: z.number().int().positive(),
      status: z.enum(['draft', 'ready']),
      updatedAt: z.string(),
    })) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => asResult({ workflows: await dependencies.workflows.list(context) }))
  server.registerTool('workflow_get', {
    title: 'Workflow versionを取得',
    description: '保存済みWorkflowの指定versionを返します。',
    inputSchema: { workflowId: z.string().min(1), version: z.number().int().positive().optional() },
    outputSchema: savedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workflowId, version }) => asResult(await dependencies.workflows.require(context, workflowId, version)))
  server.registerTool('workflow_save', {
    title: 'Workflowを保存',
    description: '利用者が確認したWorkflowをimmutable versionとして保存します。',
    inputSchema: { workflow: workflowSchema, expectedVersion: z.number().int().nonnegative().optional() },
    outputSchema: savedWorkflowSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workflow, expectedVersion }) => asResult(
    await dependencies.workflows.save(context, workflow, 'agent', expectedVersion),
  ))
  server.registerTool('workflow_archive', {
    title: 'Workflowを削除',
    description: 'Workflowのheadをarchiveし、過去versionは監査・再現用に保持します。',
    inputSchema: { workflowId: z.string().min(1), expectedVersion: z.number().int().positive().optional() },
    outputSchema: { archived: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workflowId, expectedVersion }) => asResult({
    archived: await dependencies.workflows.archive(context, workflowId, expectedVersion),
  }))
  server.registerTool('workflow_execute', {
    title: '保存済みWorkflowを実行',
    description: '現在のWorkspaceに保存されたimmutable versionを実行します。CSV出力を含む場合はBFFの承認経路を使用します。',
    inputSchema: { workflowId: z.string().min(1), version: z.number().int().positive().optional() },
    outputSchema: workflowExecutionResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workflowId, version }) => {
    const saved = await dependencies.workflows.require(context, workflowId, version)
    if (saved.workflow.steps.some((step) => step.kind === 'csv')) {
      throw new AppError('approval_required', 403, 'CSV出力を含むWorkflowはBFFの確認画面から承認して実行してください。')
    }
    const run = await dependencies.workflowExecution.execute(context, workflowId, saved.version)
    return asResult({
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      stepCount: run.steps.length,
      finalArtifact: run.finalArtifact,
    })
  })
  return server
}

async function requestBinding(request: Request): Promise<{ action: string; inputHash: string; requestId: string; protocolRequest: Request }> {
  const protocolRequest = request.clone()
  if (request.method !== 'POST') {
    return { action: `mcp:${request.method.toLowerCase()}`, inputHash: contentHash({ method: request.method }),
      requestId: request.headers.get('X-Request-Id') ?? `mcp-${request.method.toLowerCase()}`, protocolRequest }
  }
  const body = await request.json() as { id?: string | number; method?: string; params?: { name?: string } }
  const action = body.method === 'tools/call' && body.params?.name ? body.params.name : `mcp:${body.method ?? 'unknown'}`
  const requestId = request.headers.get('X-Request-Id') ?? `mcp-${String(body.id ?? 'notification')}`
  return { action, inputHash: contentHash(body), requestId, protocolRequest }
}

export function createMcpRequestHandler(options: {
  expectedHost: string
  expectedOrigin: string
  verifier: BackendAccessTokenVerifier
  invocations: McpInvocationRepository
  dependencies: McpDependencies
}) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('Host') !== options.expectedHost) return Response.json({ error: 'invalid_host' }, { status: 403 })
    if (request.headers.get('Origin') !== options.expectedOrigin) return Response.json({ error: 'invalid_origin' }, { status: 403 })
    let invocationId: string | undefined
    try {
      const binding = await requestBinding(request)
      const context = await options.verifier.verify(
        bearerToken(request.headers.get('Authorization') ?? undefined),
        ['backend:mcp'],
        binding.requestId,
      )
      invocationId = await options.invocations.start(context, binding.action, binding.inputHash)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const server = createMixerMcpServer(context, options.dependencies)
      await server.connect(transport)
      const response = await transport.handleRequest(binding.protocolRequest)
      await options.invocations.finish(invocationId, response.status < 400 ? 'completed' : 'failed', { httpStatus: response.status })
      if (!response.body) {
        await Promise.allSettled([transport.close(), server.close()])
        return response
      }
      const stream = new TransformStream<Uint8Array, Uint8Array>()
      void response.body.pipeTo(stream.writable).finally(() => Promise.allSettled([transport.close(), server.close()]))
      return new Response(stream.readable, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      if (invocationId) await options.invocations.finish(invocationId, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error',
      }).catch(() => undefined)
      const status = error instanceof AppError ? error.status : 500
      return Response.json({ error: error instanceof AppError ? error.code : 'internal_error' }, { status })
    }
  }
}
