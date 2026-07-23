import type { z } from 'zod'
import type { databaseStorageSchema } from '../../shared/runtime-config'
import { resolveDatabaseDriver } from '../../shared/persistence/database-secret'
import { BffDatabase } from './bff-database'

export type BffStorageConfig = z.infer<typeof databaseStorageSchema>
export type BffStorage = { database: BffDatabase; close(): Promise<void> }

export async function openBffStorage(config: BffStorageConfig): Promise<BffStorage> {
  const database = await BffDatabase.open(await resolveDatabaseDriver(config))
  return { database, close: () => database.close() }
}
