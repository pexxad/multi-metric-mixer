import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import type { RequestContext } from './request-context'
import { AppError } from '../shared/errors'

const encodedPart = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/)
const capabilityHeaderSchema = z.object({
  alg: z.literal('EdDSA'),
  typ: z.literal('JWT'),
  kid: z.string().min(1).max(100),
}).strict()

export const backendCapabilityClaimsSchema = z.object({
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
  scope: z.array(z.string().min(1)).min(1),
  action: z.string().min(1),
  input_hash: z.string().length(64),
  request_id: z.string().min(1),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  workflow_content_hash: z.string().length(64).optional(),
  approval_id: z.string().min(1).optional(),
}).strict()
export type BackendCapabilityClaims = z.infer<typeof backendCapabilityClaimsSchema>

export type BackendCapabilityRequest = {
  action: string
  inputHash: string
  scopes: string[]
  workflowContentHash?: string
  approvalId?: string
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decode(value: string): unknown {
  encodedPart.parse(value)
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
}

function privateKey(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' })
}

function publicKey(value: string): KeyObject {
  return createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
}

export class BackendCapabilityIssuer {
  private readonly key: KeyObject

  constructor(
    private readonly config: { issuer: string; audience: string; keyId: string; privateKeyBase64: string; ttlSeconds: number },
  ) {
    this.key = privateKey(config.privateKeyBase64)
  }

  issue(context: RequestContext, request: BackendCapabilityRequest): string {
    const now = Math.floor(Date.now() / 1_000)
    const claims: BackendCapabilityClaims = {
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
      scope: request.scopes,
      action: request.action,
      input_hash: request.inputHash,
      request_id: context.requestId,
      jti: randomUUID(),
      iat: now,
      nbf: now - 1,
      exp: now + this.config.ttlSeconds,
      ...(request.workflowContentHash ? { workflow_content_hash: request.workflowContentHash } : {}),
      ...(request.approvalId ? { approval_id: request.approvalId } : {}),
    }
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: this.config.keyId })}.${encode(claims)}`
    return `${signingInput}.${sign(null, Buffer.from(signingInput), this.key).toString('base64url')}`
  }
}

export class BackendCapabilityVerifier {
  private readonly key: KeyObject
  private readonly used = new Map<string, number>()

  constructor(private readonly config: {
    issuer: string
    audience: string
    keyId: string
    publicKeyBase64: string
    clockSkewSeconds?: number
  }) {
    this.key = publicKey(config.publicKeyBase64)
  }

  verify(token: string | undefined, expected: BackendCapabilityRequest): RequestContext & { capabilityId: string } {
    if (!token) throw new AppError('backend_capability_required', 401, 'バックエンド用アクセストークンが必要です。')
    const parts = token.split('.')
    if (parts.length !== 3) throw new AppError('backend_capability_invalid', 403, 'バックエンド用アクセストークンが不正です。')
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    let header: z.infer<typeof capabilityHeaderSchema>
    try {
      header = capabilityHeaderSchema.parse(decode(headerPart))
    } catch {
      throw new AppError('backend_capability_invalid', 403, 'バックエンド用アクセストークンが不正です。')
    }
    if (header.kid !== this.config.keyId) throw new AppError('backend_capability_invalid', 403, '署名鍵が一致しません。')
    const signingInput = `${headerPart}.${payloadPart}`
    if (!verify(null, Buffer.from(signingInput), this.key, Buffer.from(signaturePart, 'base64url'))) {
      throw new AppError('backend_capability_invalid', 403, 'バックエンド用アクセストークンの署名が不正です。')
    }
    let claims: BackendCapabilityClaims
    try {
      claims = backendCapabilityClaimsSchema.parse(decode(payloadPart))
    } catch {
      throw new AppError('backend_capability_invalid', 403, 'バックエンド用アクセストークンのclaimが不正です。')
    }
    const now = Math.floor(Date.now() / 1_000)
    const skew = this.config.clockSkewSeconds ?? 2
    this.prune(now)
    const valid = claims.iss === this.config.issuer
      && claims.aud === this.config.audience
      && claims.nbf <= now + skew
      && claims.exp > now - skew
      && claims.action === expected.action
      && claims.input_hash === expected.inputHash
      && expected.scopes.every((scope) => claims.scope.includes(scope))
      && (expected.workflowContentHash === undefined || claims.workflow_content_hash === expected.workflowContentHash)
      && (expected.approvalId === undefined || claims.approval_id === expected.approvalId)
    if (!valid) throw new AppError('backend_capability_invalid', 403, 'アクセストークンが失効済み、またはリクエストと一致しません。')
    if (this.used.has(claims.jti)) throw new AppError('backend_capability_replayed', 403, 'アクセストークンはすでに使用されています。')
    this.used.set(claims.jti, claims.exp)
    return {
      capabilityId: claims.jti,
      sessionHash: claims.session_hash,
      requestId: claims.request_id,
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

  private prune(now: number): void {
    for (const [id, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(id)
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  const [scheme, token] = header?.split(' ') ?? []
  return scheme === 'Bearer' ? token : undefined
}
