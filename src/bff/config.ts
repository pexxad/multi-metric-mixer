import { z } from 'zod'
import ipaddr from 'ipaddr.js'
import { resolve } from 'node:path'
import { databaseStorageSchema, exactOrigin, limitsSchema, portSchema } from '../shared/runtime-config'

const providerKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/)
const secretSchema = z.string().min(32)
const httpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS')
const agentProviderSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('disabled') }).strict(),
  z.object({ provider: z.literal('openai-compatible'), baseUrl: z.url(), model: z.string().min(1).max(200),
    apiKey: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(300_000),
    maxTokens: z.number().int().min(256).max(32_768),
    contextWindowTokens: z.number().int().min(4_096).max(2_000_000),
    transportSecurity: z.enum(['https', 'loopback-http', 'private-http']) }).strict()
    .refine((value) => value.maxTokens + 1_024 < value.contextWindowTokens,
      'OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS must leave at least 1024 tokens for model input.'),
])
const oidcLogoutSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('oidc'), useIdTokenHint: z.boolean().default(true) }),
  z.object({ mode: z.literal('cognito'), endpoint: httpsUrlSchema }),
])

function commaSeparatedOrigins(value: string): string[] {
  const origins = value.split(',').map((item) => item.trim()).filter(Boolean).map((origin) => exactOrigin(origin, 'ALLOWED_ORIGINS'))
  if (origins.length === 0 || new Set(origins).size !== origins.length) throw new Error('ALLOWED_ORIGINS must contain unique exact origins.')
  return origins
}

export const runtimeConfigSchema = z.object({
  version: z.literal(1), release: z.string().min(1),
  publicServer: z.object({ hostname: z.string().min(1), port: portSchema, origin: z.url(), allowedOrigins: z.array(z.url()).min(1) }),
  backendServer: z.object({
    hostname: z.literal('127.0.0.1'),
    port: portSchema,
    origin: z.url(),
    audience: z.url(),
    tokenIssuer: z.string().min(1),
    tokenKeyId: z.string().min(1),
    tokenPrivateKeyBase64: z.string().min(32),
    tokenTtlSeconds: z.number().int().min(5).max(60),
  }),
  auth: z.object({
    providerKey: providerKeySchema, sessionTtlSeconds: z.number().int().min(300).max(24 * 60 * 60),
    sessionSecret: secretSchema, transactionSecret: secretSchema,
    oidc: z.object({ issuer: z.url(), clientId: z.string().min(1), clientSecret: z.string().min(1).optional(),
      redirectUri: z.url(), scopes: z.array(z.string().min(1)).min(1), groupsClaim: z.string().min(1), adminGroup: z.string().min(1),
      providerLabel: z.string().min(1).max(100), logout: oidcLogoutSchema, allowInsecureLoopback: z.boolean() }),
  }),
  agent: agentProviderSchema.default({ provider: 'disabled' }),
  bffStorage: databaseStorageSchema, limits: limitsSchema,
})
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (!env.AUTH_PROVIDER_KEY) throw new Error('AUTH_PROVIDER_KEY is required; authentication never falls back implicitly.')
  if (!env.SESSION_SECRET || !env.AUTH_TRANSACTION_SECRET) throw new Error('SESSION_SECRET and AUTH_TRANSACTION_SECRET are required and must each contain at least 32 characters.')
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_REDIRECT_URI) throw new Error('OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_REDIRECT_URI are required for the selected provider.')
  const logoutMode = env.OIDC_LOGOUT_MODE ?? 'oidc'
  if (logoutMode !== 'oidc' && logoutMode !== 'cognito') throw new Error('OIDC_LOGOUT_MODE must be either oidc or cognito.')
  if (env.OIDC_LOGOUT_USE_ID_TOKEN_HINT && !['true', 'false'].includes(env.OIDC_LOGOUT_USE_ID_TOKEN_HINT)) {
    throw new Error('OIDC_LOGOUT_USE_ID_TOKEN_HINT must be either true or false.')
  }
  if (logoutMode === 'cognito' && !env.OIDC_LOGOUT_ENDPOINT) throw new Error('OIDC_LOGOUT_ENDPOINT is required when OIDC_LOGOUT_MODE=cognito.')
  const publicPort = portSchema.parse(env.PORT ?? 3000)
  const backendPort = portSchema.parse(env.BACKEND_PORT ?? 3001)
  if (publicPort === backendPort) throw new Error('PORT and BACKEND_PORT must be different listeners.')
  const publicOrigin = exactOrigin(env.PUBLIC_ORIGIN ?? `http://localhost:${publicPort}`, 'PUBLIC_ORIGIN')
  const agentProvider = env.AGENT_PROVIDER ?? 'disabled'
  if (agentProvider !== 'disabled' && agentProvider !== 'openai-compatible') {
    throw new Error('AGENT_PROVIDER must be disabled or openai-compatible.')
  }
  let agent: z.input<typeof agentProviderSchema> = { provider: 'disabled' }
  if (agentProvider === 'openai-compatible') {
    if (!env.OPENAI_COMPATIBLE_BASE_URL || !env.OPENAI_COMPATIBLE_MODEL) {
      throw new Error('OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_MODEL are required when AGENT_PROVIDER=openai-compatible.')
    }
    const baseUrl = new URL(env.OPENAI_COMPATIBLE_BASE_URL)
    const isLoopbackHttp = baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
    const isPrivateLiteralHttp = baseUrl.protocol === 'http:' && ipaddr.isValid(baseUrl.hostname)
      && ipaddr.parse(baseUrl.hostname).kind() === 'ipv4' && ipaddr.parse(baseUrl.hostname).range() === 'private'
    const allowPrivateHttp = env.OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP === 'true'
    if (env.OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP
      && !['true', 'false'].includes(env.OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP)) {
      throw new Error('OPENAI_COMPATIBLE_ALLOW_INSECURE_PRIVATE_HTTP must be either true or false.')
    }
    if (baseUrl.protocol !== 'https:' && !isLoopbackHttp && !(isPrivateLiteralHttp && allowPrivateHttp)) {
      throw new Error('OPENAI_COMPATIBLE_BASE_URL must use HTTPS, loopback HTTP, or explicitly approved private IPv4 HTTP.')
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error('OPENAI_COMPATIBLE_BASE_URL must not contain credentials, query, or fragment.')
    }
    agent = { provider: 'openai-compatible', baseUrl: baseUrl.toString(), model: env.OPENAI_COMPATIBLE_MODEL,
      apiKey: env.OPENAI_COMPATIBLE_API_KEY, timeoutMs: Number(env.OPENAI_COMPATIBLE_TIMEOUT_MS ?? 60_000),
      maxTokens: Number(env.OPENAI_COMPATIBLE_MAX_TOKENS ?? 8_192),
      contextWindowTokens: Number(env.OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS ?? 32_768),
      transportSecurity: baseUrl.protocol === 'https:' ? 'https' : isLoopbackHttp ? 'loopback-http' : 'private-http' }
  }
  return runtimeConfigSchema.parse({
    version: 1, release: env.APP_RELEASE ?? 'development',
    publicServer: { hostname: env.HOST ?? '127.0.0.1', port: publicPort, origin: publicOrigin,
      allowedOrigins: commaSeparatedOrigins(env.ALLOWED_ORIGINS ?? publicOrigin) },
    backendServer: {
      hostname: '127.0.0.1',
      port: backendPort,
      origin: exactOrigin(env.BACKEND_CALLER_ORIGIN ?? `http://127.0.0.1:${publicPort}`, 'BACKEND_CALLER_ORIGIN'),
      audience: exactOrigin(env.BACKEND_AUDIENCE ?? `http://127.0.0.1:${backendPort}`, 'BACKEND_AUDIENCE'),
      tokenIssuer: env.BACKEND_TOKEN_ISSUER ?? 'multi-metric-mixer-bff',
      tokenKeyId: env.BACKEND_TOKEN_KEY_ID ?? 'bff-1',
      tokenPrivateKeyBase64: env.BACKEND_TOKEN_PRIVATE_KEY_BASE64 ?? '',
      tokenTtlSeconds: Number(env.BACKEND_TOKEN_TTL_SECONDS ?? 15),
    },
    auth: { providerKey: env.AUTH_PROVIDER_KEY, sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS ?? 8 * 60 * 60),
      sessionSecret: env.SESSION_SECRET, transactionSecret: env.AUTH_TRANSACTION_SECRET,
      oidc: { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
        redirectUri: env.OIDC_REDIRECT_URI, scopes: (env.OIDC_SCOPES ?? 'openid email profile').split(/\s+/).filter(Boolean),
        groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups', adminGroup: env.OIDC_ADMIN_GROUP ?? 'multi-metric-mixer-admins',
        providerLabel: env.AUTH_PROVIDER_LABEL ?? 'Organization sign-in',
        logout: logoutMode === 'cognito' ? { mode: 'cognito', endpoint: env.OIDC_LOGOUT_ENDPOINT }
          : { mode: 'oidc', useIdTokenHint: env.OIDC_LOGOUT_USE_ID_TOKEN_HINT !== 'false' },
        allowInsecureLoopback: env.OIDC_ALLOW_HTTP_LOOPBACK === 'true' } },
    agent,
    bffStorage: env.BFF_STORAGE_DRIVER === 'postgres'
      ? { driver: 'postgres', databaseUrlSecretId: env.BFF_DATABASE_URL_SECRET_ID ?? '', awsRegion: env.AWS_REGION ?? '' }
      : { driver: 'sqlite', sqlitePath: resolve(env.BFF_DATA_DIR ?? '.data', 'bff-v1.sqlite') },
    limits: {
      apiBodyBytes: Number(env.API_BODY_BYTES ?? 256 * 1024),
      uploadBytes: Number(env.UPLOAD_BYTES ?? 10 * 1024 * 1024),
      sourceResponseBytes: Number(env.SOURCE_RESPONSE_BYTES ?? 2 * 1024 * 1024),
      sourceRows: Number(env.SOURCE_ROWS ?? 5_000),
      jsonDepth: Number(env.JSON_DEPTH ?? 32),
      concurrentRunsPerWorkspace: Number(env.CONCURRENT_RUNS_PER_WORKSPACE ?? 2),
      joinRows: Number(env.JOIN_ROWS ?? 100_000),
      artifactStorageBytes: Number(env.ARTIFACT_STORAGE_BYTES ?? 1024 * 1024 * 1024),
      artifactRetentionDays: Number(env.ARTIFACT_RETENTION_DAYS ?? 30),
    },
  })
}
