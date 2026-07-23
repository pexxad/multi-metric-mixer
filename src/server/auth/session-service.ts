import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ApplicationDatabase } from '../persistence/database'
import type { ApplicationRole, AssuranceLevel, AuthenticatedIdentity, Principal, WorkspaceContext } from '../persistence/identity-repository'
import type { AuthorizationTransaction } from './provider'

const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
export type RequestIdentity = { sessionHash: string; principal: Principal; workspace: WorkspaceContext;
  applicationRole: ApplicationRole; assuranceLevel: AssuranceLevel }

export function applicationRoleFromClaims(claimRows: Array<{ claims_json: string }>): ApplicationRole {
  return claimRows.some((row) => {
    try { return (JSON.parse(row.claims_json) as { applicationRole?: unknown }).applicationRole === 'admin' } catch { return false }
  }) ? 'admin' : 'user'
}

export class SessionService {
  private readonly csrfKey: Buffer
  private readonly logoutHintKey: Buffer
  constructor(private readonly database: ApplicationDatabase, sessionSecret: string, private readonly ttlSeconds: number) {
    this.csrfKey = createHash('sha256').update(sessionSecret).digest()
    this.logoutHintKey = createHash('sha256').update('logout-hint:').update(sessionSecret).digest()
  }
  private encryptLogoutHint(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.logoutHintKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
  }
  private decryptLogoutHint(value: string): string | undefined {
    try {
      const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'))
      if (!iv || !tag || !ciphertext) return undefined
      const decipher = createDecipheriv('aes-256-gcm', this.logoutHintKey, iv); decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch { return undefined }
  }
  async create(identity: AuthenticatedIdentity, logoutHint?: string): Promise<{ token: string; csrfToken: string; identity: RequestIdentity }> {
    const token = randomToken()
    const sessionHash = hashToken(token)
    const now = Date.now()
    await this.database.query.insertInto('auth_sessions').values({ session_hash: sessionHash, principal_id: identity.principal.id,
      active_workspace_id: identity.workspace.id, assurance_level: identity.assuranceLevel, created_at: now,
      expires_at: now + this.ttlSeconds * 1000, rotated_at: null, revoked_at: null,
      logout_hint_ciphertext: logoutHint ? this.encryptLogoutHint(logoutHint) : null }).execute()
    return { token, csrfToken: this.csrfToken(token), identity: { sessionHash, ...identity } }
  }
  async get(token: string | undefined): Promise<RequestIdentity | undefined> {
    if (!token) return undefined
    const row = await this.database.query.selectFrom('auth_sessions as s')
      .innerJoin('principals as p', 'p.id', 's.principal_id').innerJoin('workspaces as w', 'w.id', 's.active_workspace_id')
      .innerJoin('workspace_memberships as m', (join) => join.onRef('m.workspace_id', '=', 'w.id').onRef('m.principal_id', '=', 'p.id'))
      .select(['s.session_hash', 's.assurance_level', 's.expires_at', 'p.id as principal_id', 'p.display_name', 'p.email',
        'p.status as principal_status', 'w.id as workspace_id', 'w.name as workspace_name', 'w.slug', 'w.status as workspace_status',
        'm.role', 'm.version as membership_version'])
      .where('s.session_hash', '=', hashToken(token)).where('s.revoked_at', 'is', null).executeTakeFirst() as Record<string, unknown> | undefined
    if (!row || Number(row.expires_at) <= Date.now() || row.principal_status !== 'active' || row.workspace_status !== 'active') return undefined
    const claimRows = await this.database.query.selectFrom('auth_identities').select('claims_json')
      .where('principal_id', '=', row.principal_id as string).execute() as Array<{ claims_json: string }>
    return { sessionHash: row.session_hash as string,
      principal: { id: row.principal_id as string, displayName: row.display_name as string,
        email: row.email as string | undefined, status: 'active' },
      workspace: { id: row.workspace_id as string, name: row.workspace_name as string, slug: row.slug as string,
        role: row.role as WorkspaceContext['role'], membershipVersion: Number(row.membership_version) },
      applicationRole: applicationRoleFromClaims(claimRows),
      assuranceLevel: row.assurance_level as AssuranceLevel }
  }
  csrfToken(sessionToken: string): string {
    return createHmac('sha256', this.csrfKey).update(`csrf:${sessionToken}`).digest('base64url')
  }
  verifyCsrf(sessionToken: string, provided: string | undefined): boolean {
    if (!provided) return false
    const expected = Buffer.from(this.csrfToken(sessionToken)); const actual = Buffer.from(provided)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  async logoutHint(token: string | undefined): Promise<string | undefined> {
    if (!token) return undefined
    const row = await this.database.query.selectFrom('auth_sessions')
      .select(['logout_hint_ciphertext', 'expires_at', 'revoked_at']).where('session_hash', '=', hashToken(token)).executeTakeFirst() as {
        logout_hint_ciphertext: string | null; expires_at: number; revoked_at: number | null
      } | undefined
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now() || !row.logout_hint_ciphertext) return undefined
    return this.decryptLogoutHint(row.logout_hint_ciphertext)
  }
  async rotate(token: string): Promise<{ token: string; csrfToken: string; identity: RequestIdentity } | undefined> {
    const identity = await this.get(token)
    if (!identity) return undefined
    return this.database.query.transaction().execute(async (db) => {
      const current = await db.selectFrom('auth_sessions').select('logout_hint_ciphertext')
        .where('session_hash', '=', identity.sessionHash).where('revoked_at', 'is', null).executeTakeFirst() as {
          logout_hint_ciphertext: string | null
        } | undefined
      if (!current) return undefined
      const result = await db.updateTable('auth_sessions').set({ revoked_at: Date.now(), rotated_at: Date.now() })
        .where('session_hash', '=', identity.sessionHash).where('revoked_at', 'is', null).executeTakeFirst()
      if (Number(result.numUpdatedRows) !== 1) return undefined
      const nextToken = randomToken(); const nextHash = hashToken(nextToken); const now = Date.now()
      await db.insertInto('auth_sessions').values({ session_hash: nextHash, principal_id: identity.principal.id,
        active_workspace_id: identity.workspace.id, assurance_level: identity.assuranceLevel, created_at: now,
        expires_at: now + this.ttlSeconds * 1000, rotated_at: null, revoked_at: null,
        logout_hint_ciphertext: current.logout_hint_ciphertext }).execute()
      return { token: nextToken, csrfToken: this.csrfToken(nextToken), identity: { ...identity, sessionHash: nextHash } }
    })
  }
  async revoke(token: string | undefined): Promise<void> {
    if (token) await this.database.query.updateTable('auth_sessions').set({ revoked_at: Date.now() })
      .where('session_hash', '=', hashToken(token)).execute()
  }
}

export class AuthTransactionStore {
  private readonly encryptionKey: Buffer
  constructor(private readonly database: ApplicationDatabase, secret: string) { this.encryptionKey = createHash('sha256').update(secret).digest() }
  async create(transaction: AuthorizationTransaction, ttlSeconds = 10 * 60): Promise<string> {
    const token = randomToken(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction), 'utf8'), cipher.final()])
    const payload = [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString('base64url')).join('.')
    const now = Date.now()
    await this.database.query.insertInto('auth_transactions').values({ transaction_hash: hashToken(token), provider_key: transaction.providerKey,
      encrypted_payload: payload, created_at: now, expires_at: now + ttlSeconds * 1000 }).execute()
    return token
  }
  async consume(token: string | undefined): Promise<AuthorizationTransaction | undefined> {
    if (!token) return undefined
    const key = hashToken(token)
    const row = await this.database.query.transaction().execute(async (db) => {
      const found = await db.selectFrom('auth_transactions').select(['encrypted_payload', 'expires_at'])
        .where('transaction_hash', '=', key).executeTakeFirst() as { encrypted_payload: string; expires_at: number } | undefined
      await db.deleteFrom('auth_transactions').where('transaction_hash', '=', key).execute()
      return found
    })
    if (!row || Number(row.expires_at) <= Date.now()) return undefined
    const [iv, tag, ciphertext] = row.encrypted_payload.split('.').map((value) => Buffer.from(value, 'base64url'))
    if (!iv || !tag || !ciphertext) return undefined
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv); decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as AuthorizationTransaction
  }
}
