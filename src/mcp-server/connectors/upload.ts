import { AppError } from '../../server/errors'
import type { RequestContext } from '../../server/request-context'
import type { ArtifactRepository, StoredArtifact } from '../../server/persistence/artifact-repository'
import type { DataSource } from '../../server/persistence/data-source-repository'
import type { QueryStep } from '../../shared/workflow'

export class UploadArtifactReadConnector {
  constructor(private readonly artifacts: ArtifactRepository) {}

  async read(context: RequestContext, source: DataSource, _config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (source.type !== 'upload-artifact') throw new AppError('source_type_mismatch', 400, 'Upload readerにはJSONまたはCSV接続が必要です。')
    const uploaded = await this.artifacts.requireTable(context, source.artifactId)
    return this.artifacts.createTable(context, `${source.id}-snapshot`, uploaded.rows,
      [...uploaded.provenance, `source:${source.id}@${source.version}`, `transport:upload-${source.format}`],
      { runId, classification: uploaded.classification })
  }
}
