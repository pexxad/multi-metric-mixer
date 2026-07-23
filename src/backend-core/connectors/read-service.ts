import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { StoredArtifact } from '../persistence/artifact-repository'
import type { DataSource, DataSourceReader } from '../persistence/data-source-repository'
import type { QueryStep } from '../../shared/workflow'

export interface DataSourceReadConnector {
  read(context: RequestContext, source: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact>
}

export class DataSourceReadService {
  private readonly connectors: Map<DataSource['type'], DataSourceReadConnector>

  constructor(private readonly sources: DataSourceReader,
    connectors: Partial<Record<DataSource['type'], DataSourceReadConnector>>) {
    this.connectors = new Map(Object.entries(connectors) as Array<[DataSource['type'], DataSourceReadConnector]>)
  }

  async query(context: RequestContext, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    const source = await this.sources.get(context, config.source)
    if (!source) throw new AppError('source_not_found', 404, `データソース「${config.source}」は登録されていません。`)
    const connector = this.connectors.get(source.type)
    if (!connector) throw new AppError('source_connector_unavailable', 503, `データソース「${source.type}」のreaderが構成されていません。`)
    return connector.read(context, source, config, runId)
  }
}
