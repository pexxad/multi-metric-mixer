import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('EC2 deployment policy', () => {
  it('publishes only the BFF port and starts separate hardened services', async () => {
    const network = await readFile('deploy/ec2/network-boundary.yaml', 'utf8')
    expect(network).toContain('FromPort: 3000')
    expect(network).not.toMatch(/FromPort:\s*3001|ToPort:\s*3001/)
    const bff = await readFile('deploy/ec2/multi-metric-mixer-bff.service', 'utf8')
    const mcp = await readFile('deploy/ec2/multi-metric-mixer-mcp.service', 'utf8')
    expect(bff).toContain('dist/server/bff.mjs')
    expect(mcp).toContain('dist/server/mcp.mjs')
    for (const unit of [bff, mcp]) expect(unit).toContain('NoNewPrivileges=true')
  })

  it('allows source reads but no external data-source mutation in the task role', async () => {
    const policy = await readFile('deploy/ec2/iam-policy.json', 'utf8')
    for (const allowed of ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'logs:StartQuery', 'logs:GetQueryResults']) {
      expect(policy).toContain(allowed)
    }
    for (const denied of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'logs:PutLogEvents', 'logs:PutRetentionPolicy']) {
      expect(policy).not.toContain(denied)
    }
    expect(policy).toContain('multi-metric-mixer/production/data-sources/*')
  })

  it('keeps the local Keycloak and databases loopback-only and independent from production auth', async () => {
    const compose = await readFile('local/compose.yaml', 'utf8')
    const realm = JSON.parse(await readFile('local/keycloak/realm.json', 'utf8')) as {
      groups: Array<{ name: string }>
      users: Array<{ username: string; groups?: string[] }>
      clients: Array<{ standardFlowEnabled: boolean; directAccessGrantsEnabled: boolean; redirectUris: string[];
        attributes: Record<string, string>; protocolMappers: Array<{ protocolMapper: string; config: Record<string, string> }> }>
    }
    for (const port of ['127.0.0.1:8080:8080', '127.0.0.1:5433:5432', '127.0.0.1:27017:27017']) expect(compose).toContain(port)
    expect(compose).not.toContain('0.0.0.0')
    expect(compose).toContain('quay.io/keycloak/keycloak:26.7.0')
    expect(realm.clients[0]).toMatchObject({ standardFlowEnabled: true, directAccessGrantsEnabled: false })
    expect(realm.clients[0]?.redirectUris).toEqual(['http://localhost:5173/auth/callback'])
    expect(realm.clients[0]?.attributes['post.logout.redirect.uris']).toBe('http://localhost:5173/')
    expect(realm.groups.map((group) => group.name)).toContain('multi-metric-mixer-admins')
    expect(realm.users.find((user) => user.username === 'admin@example.com')?.groups).toEqual(['/multi-metric-mixer-admins'])
    expect(realm.users.find((user) => user.username === 'alice@example.com')?.groups).toBeUndefined()
    expect(realm.clients[0]?.protocolMappers).toContainEqual(expect.objectContaining({
      protocolMapper: 'oidc-group-membership-mapper', config: expect.objectContaining({ 'claim.name': 'groups', 'id.token.claim': 'true' }),
    }))
  })
})
