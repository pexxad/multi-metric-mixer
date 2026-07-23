import { z } from 'zod'

export const portSchema = z.coerce.number().int().min(1).max(65_535)
const positiveInteger = z.coerce.number().int().positive()

export const databaseStorageSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), sqlitePath: z.string().min(1) }),
  z.object({ driver: z.literal('postgres'), databaseUrlSecretId: z.string().min(1), awsRegion: z.string().min(1) }),
])

export const limitsSchema = z.object({
  apiBodyBytes: positiveInteger,
  uploadBytes: positiveInteger,
  sourceResponseBytes: positiveInteger,
  sourceRows: positiveInteger,
  jsonDepth: positiveInteger,
  concurrentRunsPerWorkspace: positiveInteger,
  joinRows: positiveInteger.default(100_000),
  artifactStorageBytes: positiveInteger.default(1024 * 1024 * 1024),
  artifactRetentionDays: positiveInteger.default(30),
})

export function exactOrigin(value: string, label: string): string {
  const url = new URL(value)
  if (url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an exact origin without a path, query, fragment, or trailing slash.`)
  }
  return url.origin
}
