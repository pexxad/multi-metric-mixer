import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { AppError } from '../shared/errors'
import type { ConnectionProfilesConfig } from '../shared/backend-runtime-config'
import type { DataModel } from '../shared/data-source'
import type { PublicConnectionProfile } from '../shared/connection-profile'
import type { DatabaseConnectionResolver } from '../backend-core/connectors/databases'

const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/)
const denyPattern = z.string().min(1).max(257).regex(/^[A-Za-z_][A-Za-z0-9_$-]*\.(?:[A-Za-z_][A-Za-z0-9_$-]*|\*)$/)
const tls = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('verify-full'), caCertificate: z.string().min(1).optional() }).strict(),
  z.object({ mode: z.literal('disable-loopback') }).strict(),
])
const hasProtocol = (value: string, protocols: string[]) =>
  URL.canParse(value) && protocols.includes(new URL(value).protocol)

const profileSchema = z.discriminatedUnion('dataModel', [
  z.object({
    id,
    displayName: z.string().min(1).max(100),
    dataModel: z.literal('table'),
    uri: z.string().min(1).refine((value) => hasProtocol(value, ['postgres:', 'postgresql:', 'sqlite:']),
      '表形式接続URIはpostgresqlまたはsqliteが必要です'),
    tls: tls.optional(),
    deniedDatasets: z.array(denyPattern).default([]),
  }).strict(),
  z.object({
    id,
    displayName: z.string().min(1).max(100),
    dataModel: z.literal('documents'),
    uri: z.string().min(1).refine((value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'JSONライク接続URIはmongodbが必要です'),
    deniedDatasets: z.array(denyPattern).default([]),
  }).strict(),
])
const fileSchema = z.object({ connections: z.array(profileSchema).max(100) }).strict()

export type ConnectionProfile = z.infer<typeof profileSchema>
export interface ConnectionProfileRegistry extends DatabaseConnectionResolver {
  listPublic(): Promise<PublicConnectionProfile[]>
  resolve(id: string, expectedModel: 'table' | 'documents'): Promise<ConnectionProfile>
}

export class FileConnectionProfileRegistry implements ConnectionProfileRegistry {
  private cache?: Promise<ConnectionProfile[]>

  constructor(private readonly filename: string) {}

  private load(): Promise<ConnectionProfile[]> {
    this.cache ??= (async () => {
      let metadata
      try { metadata = await stat(this.filename) }
      catch { throw new AppError('connection_profile_file_unavailable', 503, '接続プロファイルファイルを読み取れません。') }
      if (!metadata.isFile() || metadata.size > 256 * 1024) {
        throw new AppError('connection_profile_file_invalid', 500, '接続プロファイルファイルが不正です。')
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new AppError('connection_profile_file_permissions', 500, '接続プロファイルファイルは所有者だけが読める権限にしてください。')
      }
      try {
        const profiles = fileSchema.parse(JSON.parse(await readFile(this.filename, 'utf8'))).connections
        if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
          throw new Error('duplicate connection profile id')
        }
        return profiles
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('connection_profile_file_invalid', 500, '接続プロファイルファイルを解析できません。')
      }
    })()
    return this.cache
  }

  async listPublic(): Promise<PublicConnectionProfile[]> {
    return (await this.load()).map(({ id, displayName, dataModel }) => ({ id, displayName, dataModel }))
  }

  async resolve(profileId: string, expectedModel: DataModel): Promise<ConnectionProfile> {
    const profile = (await this.load()).find((item) => item.id === profileId)
    if (!profile) throw new AppError('connection_profile_not_found', 400, '選択した接続プロファイルは構成されていません。')
    if (expectedModel && profile.dataModel !== expectedModel) {
      throw new AppError('connection_profile_model_mismatch', 400, '接続プロファイルとデータ形式が一致しません。')
    }
    return profile
  }
}

export function createConnectionProfileRegistry(config: ConnectionProfilesConfig): ConnectionProfileRegistry {
  return new FileConnectionProfileRegistry(config.filePath)
}

export function deniedByProfile(profile: ConnectionProfile, namespace: string | undefined, dataset: string): boolean {
  const qualified = `${namespace ?? 'main'}.${dataset}`.normalize('NFKC').toLocaleLowerCase('en-US')
  return profile.deniedDatasets.some((pattern) => {
    const normalized = pattern.normalize('NFKC').toLocaleLowerCase('en-US')
    return normalized.endsWith('.*') ? qualified.startsWith(normalized.slice(0, -1)) : qualified === normalized
  })
}
