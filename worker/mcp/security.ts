import { createRemoteJWKSet, jwtVerify } from 'jose'

export type McpEnv = {
  MCP_ENABLED?: string
  MCP_WRITES_ENABLED?: string
  MCP_RESOURCE_URL?: string
  MCP_OAUTH_ISSUER?: string
  MCP_OAUTH_JWKS_URL?: string
  MCP_OAUTH_PHONE_CLAIM_NAMESPACE?: string
  MCP_ALLOWED_ORIGINS?: string
  MCP_CONFIRM_CLIENT_ID?: string
  MCP_CONFIRM_AUTH_URL?: string
  MCP_CONFIRM_TOKEN_URL?: string
  MCP_CONFIRM_CONNECTION?: string
  TURNSTILE_SITE_KEY?: string
}
export type Principal = { id: string; phone: string; scopes: string[] }
export class McpError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export function resource(env: McpEnv) {
  const url = new URL(env.MCP_RESOURCE_URL || 'https://invalid.invalid/mcp')
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password || url.hostname === 'invalid.invalid') throw new McpError('mcp_not_configured', 503)
  return url
}
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export async function authenticate(request: Request, env: McpEnv): Promise<Principal | null> {
  const authorization = request.headers.get('Authorization')
  if (!authorization) return null
  if (!/^Bearer [^\s]+$/i.test(authorization) || authorization.length > 16384) throw new McpError('invalid_token', 401)
  if (!env.MCP_OAUTH_ISSUER || !env.MCP_OAUTH_JWKS_URL) throw new McpError('oauth_not_configured', 503)
  const issuer = new URL(env.MCP_OAUTH_ISSUER)
  const jwks = new URL(env.MCP_OAUTH_JWKS_URL)
  if (issuer.protocol !== 'https:' || jwks.protocol !== 'https:' || jwks.origin !== issuer.origin) throw new McpError('oauth_not_configured', 503)
  let keys = keySets.get(jwks.href)
  if (!keys) { keys = createRemoteJWKSet(jwks, { timeoutDuration: 4000 }); keySets.set(jwks.href, keys) }
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, {
      issuer: env.MCP_OAUTH_ISSUER, audience: resource(env).href,
      algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
    })
    if (!payload.sub || typeof payload.scope !== 'string') throw Error('claims')
    // Auth0 access tokens require namespaced custom OIDC phone claims.
    const namespace = env.MCP_OAUTH_PHONE_CLAIM_NAMESPACE
    const phone = payload[namespace ? `${namespace}/phone_number` : 'phone_number']
    const verified = payload[namespace ? `${namespace}/phone_number_verified` : 'phone_number_verified']
    return { id: await digest(`${payload.iss}\n${payload.sub}`), scopes: payload.scope.split(' '),
      phone: verified === true && typeof phone === 'string' && /^\+1\d{10}$/.test(phone) ? phone : '' }
  } catch { throw new McpError('invalid_token', 401) }
}
export function requireScope(principal: Principal | null, scope: string) {
  if (!principal) throw new McpError('authorization_required', 401)
  if (!principal.scopes.includes(scope)) throw new McpError('insufficient_scope', 403)
  return principal
}
export function challenge(env: McpEnv, scope?: string) {
  return `Bearer resource_metadata="${resource(env).origin}/.well-known/oauth-protected-resource/mcp"${scope ? `, scope="${scope}"` : ''}`
}
