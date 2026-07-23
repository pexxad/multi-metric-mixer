import { resolve } from 'node:path'
import { z } from 'zod'

export const portSchema = z.coerce.number().int().min(1).max(65_535)
const positiveInteger = z.coerce.number().int().positive()
export const storageSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), sqlitePath: z.string().min(1), artifactPath: z.string().min(1) }),
  z.object({ driver: z.literal('postgres'), databaseUrlSecretId: z.string().min(1), artifactBucket: z.string().min(3),
    artifactPrefix: z.string().min(1), artifactKmsKeyId: z.string().min(1), awsRegion: z.string().min(1) }),
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
export const sourceNetworkSchema = z.object({ allowedPrivateHosts: z.array(z.string()), allowedHttpHosts: z.array(z.string()) })
const sourceSecretsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('file'), filePath: z.string().min(1) }),
  z.object({ provider: z.literal('aws-secrets-manager'), awsRegion: z.string().min(1), prefix: z.string() }),
])
export const mcpServerSchema = z.object({
  hostname: z.literal('127.0.0.1'), port: portSchema, origin: z.url(), grantTtlSeconds: z.number().int().min(5).max(60),
})

export function exactOrigin(value: string, label: string): string {
  const url = new URL(value)
  if (url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an exact origin without a path, query, fragment, or trailing slash.`)
  }
  return url.origin
}

export const mcpRuntimeConfigSchema = z.object({
  release: z.string().min(1),
  mcpServer: mcpServerSchema,
  storage: storageSchema,
  limits: limitsSchema,
  sourceNetwork: sourceNetworkSchema,
  sourceSecrets: sourceSecretsSchema,
  publicOrigin: z.url(),
})
export type McpRuntimeConfig = z.infer<typeof mcpRuntimeConfigSchema>

export function loadMcpRuntimeConfig(env: NodeJS.ProcessEnv = process.env): McpRuntimeConfig {
  const mcpPort = portSchema.parse(env.MCP_PORT ?? 3001)
  const publicPort = portSchema.parse(env.PORT ?? 3000)
  const storage = env.STORAGE_DRIVER === 'postgres'
    ? { driver: 'postgres' as const, databaseUrlSecretId: env.DATABASE_URL_SECRET_ID ?? '',
        artifactBucket: env.ARTIFACT_BUCKET ?? '', artifactPrefix: env.ARTIFACT_PREFIX ?? 'multi-metric-mixer',
        artifactKmsKeyId: env.ARTIFACT_KMS_KEY_ID ?? '', awsRegion: env.AWS_REGION ?? '' }
    : { driver: 'sqlite' as const, sqlitePath: resolve(env.DATA_DIR ?? '.data', 'multi-metric-mixer-v1.sqlite'),
        artifactPath: resolve(env.DATA_DIR ?? '.data', 'artifacts') }
  if (env.DATA_SOURCE_SECRET_PROVIDER && !['file', 'aws-secrets-manager'].includes(env.DATA_SOURCE_SECRET_PROVIDER)) {
    throw new Error('DATA_SOURCE_SECRET_PROVIDER must be file or aws-secrets-manager.')
  }
  const sourceSecrets = env.DATA_SOURCE_SECRET_PROVIDER === 'aws-secrets-manager'
    ? { provider: 'aws-secrets-manager' as const, awsRegion: env.AWS_REGION ?? '', prefix: env.DATA_SOURCE_SECRET_PREFIX ?? '' }
    : { provider: 'file' as const, filePath: resolve(env.DATA_SOURCE_SECRET_FILE ?? '.data/data-source-secrets.json') }
  if (storage.driver === 'postgres' && sourceSecrets.provider !== 'aws-secrets-manager') {
    throw new Error('PostgreSQL production storage requires DATA_SOURCE_SECRET_PROVIDER=aws-secrets-manager.')
  }
  return mcpRuntimeConfigSchema.parse({
    release: env.APP_RELEASE ?? 'development',
    mcpServer: { hostname: '127.0.0.1', port: mcpPort,
      origin: exactOrigin(env.MCP_CALLER_ORIGIN ?? `http://127.0.0.1:${publicPort}`, 'MCP_CALLER_ORIGIN'),
      grantTtlSeconds: Number(env.MCP_GRANT_TTL_SECONDS ?? 30) },
    storage,
    limits: { apiBodyBytes: Number(env.API_BODY_BYTES ?? 256 * 1024), uploadBytes: Number(env.UPLOAD_BYTES ?? 10 * 1024 * 1024),
      sourceResponseBytes: Number(env.SOURCE_RESPONSE_BYTES ?? 2 * 1024 * 1024), sourceRows: Number(env.SOURCE_ROWS ?? 5_000),
      jsonDepth: Number(env.JSON_DEPTH ?? 32), concurrentRunsPerWorkspace: Number(env.CONCURRENT_RUNS_PER_WORKSPACE ?? 2),
      joinRows: Number(env.JOIN_ROWS ?? 100_000), artifactStorageBytes: Number(env.ARTIFACT_STORAGE_BYTES ?? 1024 * 1024 * 1024),
      artifactRetentionDays: Number(env.ARTIFACT_RETENTION_DAYS ?? 30) },
    sourceNetwork: { allowedPrivateHosts: (env.SOURCE_ALLOWED_PRIVATE_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      allowedHttpHosts: (env.SOURCE_ALLOWED_HTTP_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean) },
    sourceSecrets,
    publicOrigin: exactOrigin(env.PUBLIC_ORIGIN ?? `http://localhost:${publicPort}`, 'PUBLIC_ORIGIN'),
  })
}
