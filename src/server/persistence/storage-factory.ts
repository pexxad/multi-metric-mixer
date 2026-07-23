import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { S3Client } from '@aws-sdk/client-s3'
import type { z } from 'zod'
import type { storageSchema } from '../config'
import { ApplicationDatabase } from './database'
import { FileArtifactContentStore, S3ArtifactContentStore, type ArtifactContentStore } from './artifact-content-store'

export type StorageConfig = z.infer<typeof storageSchema>
export type ApplicationStorage = { database: ApplicationDatabase; artifacts: ArtifactContentStore; close(): Promise<void> }

export async function openApplicationStorage(config: StorageConfig): Promise<ApplicationStorage> {
  if (config.driver === 'sqlite') {
    const database = await ApplicationDatabase.open({ kind: 'sqlite', filename: config.sqlitePath })
    return { database, artifacts: new FileArtifactContentStore(config.artifactPath), close: () => database.close() }
  }
  const secrets = new SecretsManagerClient({ region: config.awsRegion })
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: config.databaseUrlSecretId }))
  let databaseSecret: { connectionString: string; caCertificate: string }
  try { databaseSecret = JSON.parse(result.SecretString ?? '') as typeof databaseSecret }
  catch { throw new Error('DATABASE_URL secret must be JSON containing connectionString and caCertificate.') }
  if (!databaseSecret.connectionString?.startsWith('postgres') || !databaseSecret.caCertificate?.includes('BEGIN CERTIFICATE')) {
    throw new Error('DATABASE_URL secret must contain a PostgreSQL connectionString and trusted CA certificate.')
  }
  const database = await ApplicationDatabase.open({ kind: 'postgres', ...databaseSecret })
  const artifacts = new S3ArtifactContentStore(new S3Client({ region: config.awsRegion }), config.artifactBucket,
    config.artifactPrefix, config.artifactKmsKeyId)
  return { database, artifacts, close: () => database.close() }
}
