import { readFile, stat } from 'node:fs/promises'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { z } from 'zod'
import { AppError } from '../../server/errors'
import type { McpRuntimeConfig } from '../../server/config'

const postgresqlSecretSchema = z.object({
  type: z.literal('sql'),
  driver: z.literal('postgresql'),
  connectionString: z.string().min(1),
  tls: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('verify-full'), caCertificate: z.string().min(1).optional() }),
    z.object({ mode: z.literal('disable-loopback') }),
  ]),
}).strict()

const sqliteSecretSchema = z.object({
  type: z.literal('sql'),
  driver: z.literal('sqlite'),
  filename: z.string().min(1),
}).strict()

const mongoSecretSchema = z.object({
  type: z.literal('mongodb'),
  connectionString: z.string().min(1),
}).strict()

const dataSourceSecretSchema = z.union([postgresqlSecretSchema, sqliteSecretSchema, mongoSecretSchema])
export type DataSourceSecret = z.infer<typeof dataSourceSecretSchema>

export interface DataSourceSecretProvider {
  resolve(secretId: string): Promise<DataSourceSecret>
}

function validSecretId(secretId: string): string {
  if (!/^[A-Za-z0-9/_+=.@-]{1,256}$/.test(secretId) || secretId.includes('..')) {
    throw new AppError('source_secret_id_invalid', 400, '接続secret IDが不正です。')
  }
  return secretId
}

export class FileDataSourceSecretProvider implements DataSourceSecretProvider {
  private cache?: Promise<Record<string, unknown>>

  constructor(private readonly filename: string) {}

  private load(): Promise<Record<string, unknown>> {
    this.cache ??= (async () => {
      let metadata
      try { metadata = await stat(this.filename) }
      catch { throw new AppError('source_secret_file_unavailable', 503, 'ローカル接続secretファイルを読み取れません。') }
      if (!metadata.isFile() || metadata.size > 256 * 1024) {
        throw new AppError('source_secret_file_invalid', 500, 'ローカル接続secretファイルが不正です。')
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new AppError('source_secret_file_permissions', 500, 'ローカル接続secretファイルは所有者だけが読める権限にしてください。')
      }
      try {
        const value = JSON.parse(await readFile(this.filename, 'utf8')) as unknown
        return z.record(z.string(), z.unknown()).parse(value)
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('source_secret_file_invalid', 500, 'ローカル接続secretファイルを解析できません。')
      }
    })()
    return this.cache
  }

  async resolve(secretId: string): Promise<DataSourceSecret> {
    const values = await this.load()
    const value = values[validSecretId(secretId)]
    if (!value) throw new AppError('source_secret_not_found', 503, '接続secretが構成されていません。')
    try { return dataSourceSecretSchema.parse(value) }
    catch { throw new AppError('source_secret_invalid', 500, '接続secretの形式が不正です。') }
  }
}

type SecretsReader = { send(command: GetSecretValueCommand): Promise<{ SecretString?: string }> }

export class AwsDataSourceSecretProvider implements DataSourceSecretProvider {
  constructor(region: string, private readonly prefix = '',
    private readonly client: SecretsReader = new SecretsManagerClient({ region })) {}

  async resolve(secretId: string): Promise<DataSourceSecret> {
    const id = `${this.prefix}${validSecretId(secretId)}`
    let result: { SecretString?: string }
    try { result = await this.client.send(new GetSecretValueCommand({ SecretId: id })) }
    catch { throw new AppError('source_secret_unavailable', 503, 'AWS Secrets Managerから接続secretを取得できません。') }
    try { return dataSourceSecretSchema.parse(JSON.parse(result.SecretString ?? '')) }
    catch { throw new AppError('source_secret_invalid', 500, '接続secretの形式が不正です。') }
  }
}

export function createDataSourceSecretProvider(config: McpRuntimeConfig['sourceSecrets']): DataSourceSecretProvider {
  return config.provider === 'file'
    ? new FileDataSourceSecretProvider(config.filePath)
    : new AwsDataSourceSecretProvider(config.awsRegion, config.prefix)
}
