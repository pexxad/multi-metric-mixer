import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { z } from 'zod'
import type { databaseStorageSchema } from '../runtime-config'
import type { DatabaseDriver } from './database-driver'

export type DatabaseStorageConfig = z.infer<typeof databaseStorageSchema>

export async function resolveDatabaseDriver(config: DatabaseStorageConfig): Promise<DatabaseDriver> {
  if (config.driver === 'sqlite') return { kind: 'sqlite', filename: config.sqlitePath }
  const result = await new SecretsManagerClient({ region: config.awsRegion })
    .send(new GetSecretValueCommand({ SecretId: config.databaseUrlSecretId }))
  let secret: { connectionString: string; caCertificate: string }
  try {
    secret = JSON.parse(result.SecretString ?? '') as typeof secret
  } catch {
    throw new Error(`${config.databaseUrlSecretId} must be JSON containing connectionString and caCertificate.`)
  }
  if (!secret.connectionString?.startsWith('postgres') || !secret.caCertificate?.includes('BEGIN CERTIFICATE')) {
    throw new Error(`${config.databaseUrlSecretId} must contain a PostgreSQL connectionString and trusted CA certificate.`)
  }
  return { kind: 'postgres', ...secret }
}
