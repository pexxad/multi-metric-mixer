import { resolve } from 'node:path'
import { z } from 'zod'
import { exactOrigin, limitsSchema, portSchema } from '../shared/runtime-config'
import { backendStorageSchema } from '../shared/backend-runtime-config'

export const sourceNetworkSchema = z.object({ allowedPrivateHosts: z.array(z.string()), allowedHttpHosts: z.array(z.string()) })
const connectionProfilesSchema = z.object({ filePath: z.string().min(1) })
export const backendServerSchema = z.object({
  hostname: z.literal('127.0.0.1'),
  port: portSchema,
  origin: z.url(),
  audience: z.url(),
  tokenIssuer: z.string().min(1),
  tokenKeyId: z.string().min(1),
  tokenPublicKeyBase64: z.string().min(32),
})

export const backendRuntimeConfigSchema = z.object({
  release: z.string().min(1),
  backendServer: backendServerSchema,
  backendStorage: backendStorageSchema,
  limits: limitsSchema,
  sourceNetwork: sourceNetworkSchema,
  connectionProfiles: connectionProfilesSchema,
})
export type BackendRuntimeConfig = z.infer<typeof backendRuntimeConfigSchema>

export function loadBackendRuntimeConfig(env: NodeJS.ProcessEnv = process.env): BackendRuntimeConfig {
  const backendPort = portSchema.parse(env.BACKEND_PORT ?? 3001)
  const backendStorage = env.BACKEND_STORAGE_DRIVER === 'postgres'
    ? { driver: 'postgres' as const, databaseUrlSecretId: env.BACKEND_DATABASE_URL_SECRET_ID ?? '',
        artifactBucket: env.ARTIFACT_BUCKET ?? '', artifactPrefix: env.ARTIFACT_PREFIX ?? 'multi-metric-mixer',
        artifactKmsKeyId: env.ARTIFACT_KMS_KEY_ID ?? '', awsRegion: env.AWS_REGION ?? '' }
    : { driver: 'sqlite' as const, sqlitePath: resolve(env.BACKEND_DATA_DIR ?? '.data', 'backend-v1.sqlite'),
        artifactPath: resolve(env.BACKEND_DATA_DIR ?? '.data', 'artifacts') }
  const connectionProfiles = { filePath: resolve(env.DATA_CONNECTION_PROFILES_FILE ?? '.data/connection-profiles.json') }
  return backendRuntimeConfigSchema.parse({
    release: env.APP_RELEASE ?? 'development',
    backendServer: { hostname: '127.0.0.1', port: backendPort,
      origin: exactOrigin(env.BACKEND_CALLER_ORIGIN ?? 'http://127.0.0.1:3000', 'BACKEND_CALLER_ORIGIN'),
      audience: exactOrigin(env.BACKEND_AUDIENCE ?? `http://127.0.0.1:${backendPort}`, 'BACKEND_AUDIENCE'),
      tokenIssuer: env.BACKEND_TOKEN_ISSUER ?? 'multi-metric-mixer-bff',
      tokenKeyId: env.BACKEND_TOKEN_KEY_ID ?? 'bff-1',
      tokenPublicKeyBase64: env.BACKEND_TOKEN_PUBLIC_KEY_BASE64 ?? '' },
    backendStorage,
    limits: { apiBodyBytes: Number(env.API_BODY_BYTES ?? 256 * 1024), uploadBytes: Number(env.UPLOAD_BYTES ?? 10 * 1024 * 1024),
      sourceResponseBytes: Number(env.SOURCE_RESPONSE_BYTES ?? 2 * 1024 * 1024), sourceRows: Number(env.SOURCE_ROWS ?? 5_000),
      jsonDepth: Number(env.JSON_DEPTH ?? 32), concurrentRunsPerWorkspace: Number(env.CONCURRENT_RUNS_PER_WORKSPACE ?? 2),
      joinRows: Number(env.JOIN_ROWS ?? 100_000), artifactStorageBytes: Number(env.ARTIFACT_STORAGE_BYTES ?? 1024 * 1024 * 1024),
      artifactRetentionDays: Number(env.ARTIFACT_RETENTION_DAYS ?? 30) },
    sourceNetwork: { allowedPrivateHosts: (env.SOURCE_ALLOWED_PRIVATE_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      allowedHttpHosts: (env.SOURCE_ALLOWED_HTTP_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean) },
    connectionProfiles,
  })
}
