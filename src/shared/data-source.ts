import { z } from 'zod'
import { queryTemplateSchema } from './query-template'
import type { QueryTemplate } from './query-template'

const common = {
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1).max(100),
}

const databaseIdentifier = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_$-]*$/)
const connectionIdSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/)

export const dataSourceRegistrationSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('rest-json'),
    baseUrl: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'httpまたはhttpsが必要です'),
    path: z.string().min(1).startsWith('/'),
    method: z.literal('GET'),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('dynamodb'),
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    tableName: z.string().min(3).max(255).regex(/^[A-Za-z0-9_.-]+$/),
    partitionKey: z.string().min(1).max(255),
    sortKey: z.string().min(1).max(255).optional(),
    maxItems: z.number().int().min(1).max(5_000).default(1_000),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('cloudwatch-logs'),
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    logGroupName: z.string().min(1).max(512),
    maxResults: z.number().int().min(1).max(10_000).default(1_000),
    maxRangeSeconds: z.number().int().min(60).max(31 * 24 * 60 * 60).default(7 * 24 * 60 * 60),
    queryMode: z.enum(['sample', 'template-required']).default('sample'),
    queryTemplates: z.array(queryTemplateSchema).max(20).default([]),
  }).strict().superRefine((source, context) => {
    if (source.queryMode === 'template-required' && source.queryTemplates.length === 0) {
      context.addIssue({ code: 'custom', path: ['queryTemplates'], message: '検索パターンを1件以上登録してください。' })
    }
    if (new Set(source.queryTemplates.map((template) => template.id)).size !== source.queryTemplates.length) {
      context.addIssue({ code: 'custom', path: ['queryTemplates'], message: '検索パターンIDが重複しています。' })
    }
  }),
  z.object({
    ...common,
    type: z.literal('upload-artifact'),
    artifactId: z.string().min(1),
    format: z.enum(['json', 'csv']),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('database-table'),
    connectionId: connectionIdSchema,
    schema: databaseIdentifier.optional(),
    table: databaseIdentifier,
    maxRows: z.number().int().min(1).max(5_000).default(1_000),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('database-documents'),
    connectionId: connectionIdSchema,
    database: databaseIdentifier,
    collection: databaseIdentifier,
    maxDocuments: z.number().int().min(1).max(5_000).default(1_000),
  }).strict(),
])

export type DataSourceRegistration = z.infer<typeof dataSourceRegistrationSchema>
export type DataSource = DataSourceRegistration & {
  version: number
  accessMode: 'read-only'
  status: 'active' | 'archived'
}

export type DataModel = 'table' | 'documents'
export type DataSourceCapability = {
  id: string
  name: string
  type: DataSource['type']
  dataModel: DataModel
  version: number
  accessMode: 'read-only'
  status: 'active'
  queryMode?: 'sample' | 'template-required'
  queryTemplates: Array<Omit<QueryTemplate, 'execution'>>
}

export function dataSourceDataModel(source: Pick<DataSourceRegistration, 'type'> & { format?: 'json' | 'csv' }): DataModel {
  if (source.type === 'database-table') return 'table'
  if (source.type === 'upload-artifact' && source.format === 'csv') return 'table'
  return 'documents'
}

export function dataSourceCapability(source: DataSource): DataSourceCapability {
  const queryTemplates = source.type === 'cloudwatch-logs'
    ? source.queryTemplates.map(({ execution: _execution, ...template }) => template) : []
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    dataModel: dataSourceDataModel(source),
    version: source.version,
    accessMode: 'read-only',
    status: 'active',
    ...(source.type === 'cloudwatch-logs' ? { queryMode: source.queryMode } : {}),
    queryTemplates,
  }
}
