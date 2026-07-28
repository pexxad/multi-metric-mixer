import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto'
import { errors, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import type { RequestContext } from './request-context'
import { AppError } from '../shared/errors'

const accessTokenHeaderSchema = z.object({
  alg: z.literal('EdDSA'),
  typ: z.literal('at+jwt'),
  kid: z.string().min(1).max(100),
}).strict()

export const backendAccessTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  principal_name: z.string().min(1).max(200),
  workspace_id: z.string().min(1),
  workspace_name: z.string().min(1).max(200),
  workspace_slug: z.string().min(1).max(200),
  workspace_role: z.enum(['owner', 'editor', 'runner', 'viewer']),
  membership_version: z.number().int().positive(),
  application_role: z.enum(['admin', 'user']),
  assurance_level: z.enum(['basic', 'mfa', 'strong']),
  session_hash: z.string().min(1),
  scope: z.string().min(1),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict()
export type BackendAccessTokenClaims = z.infer<typeof backendAccessTokenClaimsSchema>

function privateKey(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' })
}

function publicKey(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
}

export class BackendAccessTokenIssuer {
  private readonly key: KeyObject

  constructor(
    private readonly config: { issuer: string; audience: string; keyId: string; privateKeyBase64: string; ttlSeconds: number },
  ) {
    this.key = privateKey(config.privateKeyBase64)
  }

  async issue(context: RequestContext, scopes: string[]): Promise<string> {
    const normalizedScopes = [...new Set(scopes)].sort()
    if (normalizedScopes.length === 0 || normalizedScopes.some((scope) => !scope || /\s/.test(scope))) {
      throw new Error('Backend access token requires non-empty, whitespace-free scopes.')
    }
    const now = Math.floor(Date.now() / 1_000)
    const claims: BackendAccessTokenClaims = {
      iss: this.config.issuer,
      aud: this.config.audience,
      sub: context.principal.id,
      principal_name: context.principal.displayName,
      workspace_id: context.workspace.id,
      workspace_name: context.workspace.name,
      workspace_slug: context.workspace.slug,
      workspace_role: context.workspace.role,
      membership_version: context.workspace.membershipVersion,
      application_role: context.applicationRole,
      assurance_level: context.assuranceLevel,
      session_hash: context.sessionHash,
      scope: normalizedScopes.join(' '),
      jti: randomUUID(),
      iat: now,
      nbf: now - 1,
      exp: now + this.config.ttlSeconds,
    }
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: this.config.keyId })
      .sign(this.key)
  }
}

export class BackendAccessTokenVerifier {
  private readonly key: KeyObject

  constructor(private readonly config: {
    issuer: string
    audience: string
    keyId: string
    publicKeyBase64: string
    clockSkewSeconds?: number
  }) {
    this.key = publicKey(config.publicKeyBase64)
  }

  async verify(
    token: string | undefined,
    requiredScopes: string[],
    requestId: string,
  ): Promise<RequestContext & { accessTokenId: string }> {
    if (!token) throw new AppError('backend_access_token_required', 401, 'バックエンド用アクセストークンが必要です。')
    let payload: unknown
    let protectedHeader: unknown
    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: ['EdDSA'],
        issuer: this.config.issuer,
        audience: this.config.audience,
        typ: 'at+jwt',
        clockTolerance: this.config.clockSkewSeconds ?? 2,
        currentDate: new Date(Date.now()),
        requiredClaims: ['sub', 'jti', 'iat', 'nbf', 'exp'],
      })
      payload = verified.payload
      protectedHeader = verified.protectedHeader
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new AppError('backend_access_token_invalid', 403, 'バックエンド用アクセストークンが失効済みです。')
      }
      throw new AppError('backend_access_token_invalid', 403, 'バックエンド用アクセストークンの署名またはclaimが不正です。')
    }
    const header = accessTokenHeaderSchema.safeParse(protectedHeader)
    if (!header.success || header.data.kid !== this.config.keyId) {
      throw new AppError('backend_access_token_invalid', 403, 'バックエンド用アクセストークンの署名鍵が一致しません。')
    }
    let claims: BackendAccessTokenClaims
    try {
      claims = backendAccessTokenClaimsSchema.parse(payload)
    } catch {
      throw new AppError('backend_access_token_invalid', 403, 'バックエンド用アクセストークンのclaimが不正です。')
    }
    const scopes = new Set(claims.scope.split(' '))
    if (!requiredScopes.every((scope) => scopes.has(scope))) {
      throw new AppError('backend_access_token_invalid', 403, 'バックエンド用アクセストークンに必要な権限がありません。')
    }
    return {
      accessTokenId: claims.jti,
      sessionHash: claims.session_hash,
      requestId,
      principal: { id: claims.sub, displayName: claims.principal_name, status: 'active' },
      workspace: {
        id: claims.workspace_id,
        name: claims.workspace_name,
        slug: claims.workspace_slug,
        role: claims.workspace_role,
        membershipVersion: claims.membership_version,
      },
      applicationRole: claims.application_role,
      assuranceLevel: claims.assurance_level,
    }
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  const [scheme, token] = header?.split(' ') ?? []
  return scheme === 'Bearer' ? token : undefined
}
