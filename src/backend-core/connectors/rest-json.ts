import { AppError } from '../../shared/errors'
import type { RequestContext } from '../../shared/request-context'
import type { ArtifactRepository, StoredArtifact } from '../persistence/artifact-repository'
import type { DataSource } from '../persistence/data-source-repository'
import type { SafeHttpClient } from './safe-http'
import type { JsonValue, QueryStep } from '../../shared/workflow'
import { normalizeJsonToRows } from '../untrusted-data'
export { normalizeJsonToRows } from '../untrusted-data'

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class RestDataSourceService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly http: SafeHttpClient,
    private readonly maxRows: number,
  ) {}

  async read(context: RequestContext, source: DataSource, config: QueryStep['config'], runId?: string): Promise<StoredArtifact> {
    if (source.type !== 'rest-json') throw new AppError('source_type_mismatch', 400, 'REST query toolにはREST JSON接続が必要です。')
    const parameters = Object.entries(config.parameters)
    if (parameters.length > 50) throw new AppError('source_parameter_limit', 400, 'query parameterは50件までです。')
    const url = new URL(source.path, source.baseUrl)
    for (const [key, value] of parameters) {
      if (key.length > 128 || value.length > 2_048) throw new AppError('source_parameter_invalid', 400, 'query parameterが長すぎます。')
      url.searchParams.set(key, value)
    }
    const response = await this.http.getJson(url)
    const rows = normalizeJsonToRows(response.json, this.maxRows)
    return this.artifacts.createTable(context, `${source.id}-response`, rows, [
      `source:${source.id}@${source.version}`,
      'trust:untrusted',
      'transport:rest-json',
      `method:${source.method}`,
      `response:bytes=${response.byteLength}`,
      `redirects:${response.redirectCount}`,
      `normalize:${Array.isArray(response.json) ? 'array' : isJsonRecord(response.json) ? 'object' : 'primitive'}`,
    ], { runId })
  }
}
