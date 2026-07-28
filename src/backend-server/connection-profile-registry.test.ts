import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileConnectionProfileRegistry, deniedByProfile } from './connection-profile-registry'

describe('connection profiles', () => {
  it('loads profiles from an owner-only file and exposes only public metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mmm-connections-'))
    const filename = join(directory, 'connections.json')
    await writeFile(filename, JSON.stringify({ connections: [{ id: 'db-a', displayName: 'DB A', dataModel: 'table',
      uri: 'postgresql://reader:password@127.0.0.1/data', tls: { mode: 'disable-loopback' }, deniedDatasets: ['private.*'] }] }), { mode: 0o600 })
    await chmod(filename, 0o600)
    const registry = new FileConnectionProfileRegistry(filename)
    await expect(registry.listPublic()).resolves.toEqual([{ id: 'db-a', displayName: 'DB A', dataModel: 'table' }])
    await expect(registry.resolve('db-a', 'documents')).rejects.toThrow('一致しません')
  })

  it('matches exact and namespace-wide deny rules case-insensitively', () => {
    const profile = { id: 'db-a', displayName: 'DB A', dataModel: 'table' as const, uri: 'sqlite:///tmp/a.db',
      deniedDatasets: ['private.*', 'public.payroll'] }
    expect(deniedByProfile(profile, 'PRIVATE', 'orders')).toBe(true)
    expect(deniedByProfile(profile, 'public', 'Payroll')).toBe(true)
    expect(deniedByProfile(profile, 'public', 'sales')).toBe(false)
  })
})
