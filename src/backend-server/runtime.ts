import { createBackendCore } from '../backend-core/runtime'
import { createConnectionProfileRegistry } from './connection-profile-registry'
import type { BackendRuntimeConfig } from './config'

export type BackendServerServices = Awaited<ReturnType<typeof createBackendServerServices>>

export async function createBackendServerServices(config: BackendRuntimeConfig) {
  const connectionProfiles = createConnectionProfileRegistry(config.connectionProfiles)
  const core = await createBackendCore(config, { databaseConnections: connectionProfiles })
  return {
    core,
    connectionProfiles,
    close: () => core.close(),
  }
}
