import { z } from 'zod'

export const catalogDataTypeSchema = z.enum(['string', 'number', 'boolean', 'object', 'array', 'null'])
export const catalogClassificationSchema = z.enum(['internal', 'confidential', 'restricted'])
export const catalogPolicySchema = z.enum(['curated', 'evolving', 'hybrid'])

export const catalogFieldSchema = z.object({
  path: z.string().min(1).max(512),
  dataTypes: z.array(catalogDataTypeSchema).min(1).max(6),
  nullable: z.boolean(),
  presence: z.number().min(0).max(1),
  businessName: z.string().max(200).default(''),
  description: z.string().max(2_000).default(''),
  unit: z.string().max(100).default(''),
  timezone: z.string().max(100).default(''),
  firstSeenAt: z.string().datetime().optional(),
  lastSeenAt: z.string().datetime().optional(),
}).strict()

export const catalogRelationshipSchema = z.object({
  id: z.string().min(1).max(128),
  targetSourceId: z.string().min(1).max(64),
  localFields: z.array(z.string().min(1).max(512)).min(1).max(10),
  targetFields: z.array(z.string().min(1).max(512)).min(1).max(10),
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  description: z.string().max(2_000).default(''),
}).strict().refine((value) => value.localFields.length === value.targetFields.length,
  'Relationshipの左右field数は一致させてください。')

export const catalogDefinitionSchema = z.object({
  sourceId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(200),
  description: z.string().max(2_000).default(''),
  policy: catalogPolicySchema.default('hybrid'),
  classification: catalogClassificationSchema.default('internal'),
  defaultTimeField: z.string().max(512).nullable().default(null),
  fields: z.array(catalogFieldSchema).max(500),
  relationships: z.array(catalogRelationshipSchema).max(100).default([]),
}).strict()

export const catalogObservationSchema = z.object({
  sourceId: z.string().min(1).max(64),
  observedAt: z.string().datetime(),
  rowCount: z.number().int().nonnegative(),
  sampledRows: z.number().int().nonnegative().max(500),
  schemaFingerprint: z.string().min(1),
  fields: z.array(catalogFieldSchema).max(500),
}).strict()

export type CatalogDefinition = z.infer<typeof catalogDefinitionSchema>
export type CatalogField = z.infer<typeof catalogFieldSchema>
export type CatalogRelationship = z.infer<typeof catalogRelationshipSchema>
export type CatalogObservation = z.infer<typeof catalogObservationSchema>
export type CatalogDataType = z.infer<typeof catalogDataTypeSchema>

export type CatalogVersion = {
  id: string
  sourceId: string
  scope: 'canonical' | 'personal'
  ownerId?: string
  version: number
  baseCanonicalVersion?: number
  definition: CatalogDefinition
  schemaFingerprint: string
  changeSource: 'manual' | 'agent' | 'promotion'
  createdBy: string
  createdAt: string
}

export type CatalogBundle = {
  sourceId: string
  canonical?: CatalogVersion
  personal?: CatalogVersion
  effective?: CatalogVersion
  personalOutdated: boolean
}
