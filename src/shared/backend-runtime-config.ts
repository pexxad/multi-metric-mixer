import { z } from 'zod'
import type { limitsSchema } from './runtime-config'

export const backendStorageSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), sqlitePath: z.string().min(1), artifactPath: z.string().min(1) }),
  z.object({
    driver: z.literal('postgres'),
    databaseUrlSecretId: z.string().min(1),
    artifactBucket: z.string().min(3),
    artifactPrefix: z.string().min(1),
    artifactKmsKeyId: z.string().min(1),
    awsRegion: z.string().min(1),
  }),
])

export type BackendStorageConfig = z.infer<typeof backendStorageSchema>

export type SourceSecretsConfig =
  | { provider: 'file'; filePath: string }
  | { provider: 'aws-secrets-manager'; awsRegion: string; prefix: string }

export type BackendCoreConfig = {
  backendStorage: BackendStorageConfig
  limits: z.infer<typeof limitsSchema>
  sourceNetwork: {
    allowedPrivateHosts: string[]
    allowedHttpHosts: string[]
  }
  sourceSecrets: SourceSecretsConfig
}
