import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AwsDataSourceSecretProvider, FileDataSourceSecretProvider } from './source-secrets'

describe('data-source secret providers', () => {
  it('loads typed local secrets from an owner-only file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mmm-secrets-'))
    const filename = join(directory, 'secrets.json')
    await writeFile(filename, JSON.stringify({ postgres: { type: 'sql', driver: 'postgresql',
      connectionString: 'postgresql://reader@127.0.0.1/data', tls: { mode: 'disable-loopback' } } }), { mode: 0o600 })
    await chmod(filename, 0o600)
    await expect(new FileDataSourceSecretProvider(filename).resolve('postgres')).resolves.toMatchObject({ driver: 'postgresql' })
  })

  it('rejects unsafe secret identifiers before calling AWS', async () => {
    const client = { send: async () => ({ SecretString: '{}' }) }
    await expect(new AwsDataSourceSecretProvider('ap-northeast-1', 'prefix/', client).resolve('../database')).rejects.toThrow('不正')
  })
})
