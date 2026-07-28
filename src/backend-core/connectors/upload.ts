import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { ArtifactRepository, StoredArtifact } from '../persistence/artifact-repository'
import type { DataSource } from '../persistence/data-source-repository'
import type { QueryStep } from '../../shared/workflow'

export class UploadArtifactReadConnector {
  constructor(private readonly artifacts: ArtifactRepository) {}

  async read(context: RequestContext, source: DataSource, _config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (source.type !== 'upload-artifact') throw new AppError('source_type_mismatch', 400, 'Upload readerにはJSONまたはCSV接続が必要です。')
    if (source.format === 'json') {
      const uploaded = await this.artifacts.requireDocuments(context, source.artifactId)
      return this.artifacts.createDocuments(context, `${source.id}-snapshot`, uploaded.documents,
        [...uploaded.provenance, `source:${source.id}@${source.version}`, 'transport:upload-json'],
        { runId, classification: uploaded.classification })
    }
    const uploaded = await this.artifacts.requireTable(context, source.artifactId)
    return this.artifacts.createTable(context, `${source.id}-snapshot`, uploaded.rows,
      [...uploaded.provenance, `source:${source.id}@${source.version}`, 'transport:upload-csv'],
      { runId, classification: uploaded.classification })
  }
}
