import { S3Client } from '@aws-sdk/client-s3'
import type { BackendStorageConfig } from '../../shared/backend-runtime-config'
import { resolveDatabaseDriver } from '../../shared/persistence/database-secret'
import {
  FileArtifactContentStore,
  S3ArtifactContentStore,
  type ArtifactContentStore,
} from '../persistence/artifact-content-store'
import { BackendDatabase } from './backend-database'

export type BackendStorage = { database: BackendDatabase; artifacts: ArtifactContentStore; close(): Promise<void> }

export async function openBackendStorage(config: BackendStorageConfig): Promise<BackendStorage> {
  if (config.driver === 'sqlite') {
    const database = await BackendDatabase.open({ kind: 'sqlite', filename: config.sqlitePath })
    return {
      database,
      artifacts: new FileArtifactContentStore(config.artifactPath),
      close: () => database.close(),
    }
  }
  const database = await BackendDatabase.open(await resolveDatabaseDriver(config))
  const artifacts = new S3ArtifactContentStore(
    new S3Client({ region: config.awsRegion }),
    config.artifactBucket,
    config.artifactPrefix,
    config.artifactKmsKeyId,
  )
  return { database, artifacts, close: () => database.close() }
}
