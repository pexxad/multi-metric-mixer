import { afterEach, describe, expect, it } from 'vitest'
import { BffDatabase } from '../persistence/bff-database'
import { testBffDatabase } from '../../test-support'
import { IdentityRepository } from './identity-repository'

describe('IdentityRepository', () => {
  const databases: BffDatabase[] = []
  afterEach(async () => { for (const database of databases.splice(0)) await database.close() })

  it('normalizes provider identity and refreshes its application role on authentication', async () => {
    const database = await testBffDatabase(); databases.push(database)
    const repository = new IdentityRepository(database)
    const first = await repository.resolve({
      providerKey: 'oidc-main', subject: 'subject-1', displayName: 'Alice', email: 'alice@example.com',
      groups: ['multi-metric-mixer-admins'], applicationRole: 'admin', assuranceLevel: 'mfa',
    })
    const second = await repository.resolve({
      providerKey: 'oidc-main', subject: 'subject-1', displayName: 'Alice Updated', email: 'alice@example.com',
      groups: [], applicationRole: 'user', assuranceLevel: 'mfa',
    })
    expect(second.principal.id).toBe(first.principal.id)
    expect(second.workspace).toMatchObject({ id: 'main', role: 'editor', membershipVersion: 1 })
    expect(first.applicationRole).toBe('admin')
    expect(second.applicationRole).toBe('user')
    expect(second.principal.displayName).toBe('Alice Updated')
  })

  it('places authenticated users in the shared application Workspace', async () => {
    const database = await testBffDatabase(); databases.push(database)
    const repository = new IdentityRepository(database)
    const alice = await repository.resolve({ providerKey: 'oidc-main', subject: 'alice', displayName: 'Alice', groups: [],
      applicationRole: 'admin', assuranceLevel: 'basic' })
    const bob = await repository.resolve({ providerKey: 'oidc-main', subject: 'bob', displayName: 'Bob', groups: [],
      applicationRole: 'user', assuranceLevel: 'basic' })
    expect(alice.workspace.id).toBe('main')
    expect(bob.workspace.id).toBe(alice.workspace.id)
    await expect(repository.requireMembership(bob.principal.id, alice.workspace.id)).resolves.toMatchObject({ role: 'editor' })
  })
})
