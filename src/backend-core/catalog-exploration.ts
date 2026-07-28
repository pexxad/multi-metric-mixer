import type { RequestContext } from '../shared/request-context'
import { profileCatalogValues } from './catalog-profiler'
import type { DataSourceReadService } from './connectors/read-service'
import type { CatalogRepository } from './persistence/catalog-repository'

export class CatalogExplorationService {
  constructor(private readonly reader: DataSourceReadService, private readonly catalogs: CatalogRepository) {}

  async explorePersonal(context: RequestContext, sourceId: string, limit = 100) {
    const artifact = await this.reader.sample(context, sourceId, limit)
    const observation = profileCatalogValues(sourceId, artifact.type === 'table' ? 'table' : 'documents',
      artifact.type === 'table' ? artifact.rows ?? [] : artifact.documents ?? [], artifact.rowCount)
    const catalog = await this.catalogs.applyObservation(context, sourceId, observation)
    return { observation, catalog, artifact }
  }
}
