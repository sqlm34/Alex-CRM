export type GoogleActionsEnv = {
  GOOGLE_ACTIONS_CENTER_ENABLED?: string
  GOOGLE_ACTIONS_CENTER_ENV?: string
  GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV?: string
  GOOGLE_ACTIONS_CENTER_PRODUCTION_ENABLED?: string
  GOOGLE_ACTIONS_CENTER_PARTNER_ID?: string
  GOOGLE_ACTIONS_CENTER_MERCHANT_ID?: string
}

export const attributionLifetimeMs = 30 * 24 * 60 * 60 * 1000
export const merchantChanged = { ORIGINAL_MERCHANT: '2', DIFFERENT_MERCHANT: '1' } as const
export const conversionEndpoints = {
  sandbox: 'https://www.google.com/maps/conversion/debug/collect',
  production: 'https://www.google.com/maps/conversion/collect',
} as const

export function googleActionsConfig(env: GoogleActionsEnv) {
  if (env.GOOGLE_ACTIONS_CENTER_ENABLED !== 'true') return null
  const environment = env.GOOGLE_ACTIONS_CENTER_ENV
  const deployment = env.GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV
  if (environment !== 'sandbox' && environment !== 'production') return null
  if (environment === 'production') {
    if (deployment !== 'production' || env.GOOGLE_ACTIONS_CENTER_PRODUCTION_ENABLED !== 'true') return null
  } else if (!['local', 'test', 'preview', 'sandbox'].includes(deployment || '')) return null
  const partnerId = env.GOOGLE_ACTIONS_CENTER_PARTNER_ID?.trim()
  const merchantId = env.GOOGLE_ACTIONS_CENTER_MERCHANT_ID?.trim()
  if (!partnerId || !/^\d{1,200}$/.test(partnerId)) return null
  if (!merchantId || !/^[A-Za-z0-9_-]{1,100}$/.test(merchantId) || /TODO|PLACEHOLDER|REPLACE_ME/i.test(merchantId)) return null
  return { environment, deployment: deployment!, partnerId, merchantId, endpoint: conversionEndpoints[environment] }
}

export type GoogleActionsConfig = NonNullable<ReturnType<typeof googleActionsConfig>>

export function validateGoogleAttribution(input: unknown, config: GoogleActionsConfig, now = Date.now()) {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const token = value.rwg_token
  const captured = value.captured_at
  // Reject oversized input whole; never truncate or decode an already decoded token.
  if (typeof token !== 'string' || !token.length || token.length > 16384 || /[\s\ufffd]/.test(token)
    || [...token].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null
  if (typeof captured !== 'number' || !Number.isSafeInteger(captured) || captured <= 0 || captured > now || captured + attributionLifetimeMs <= now) return null
  if (value.merchant_id !== undefined && value.merchant_id !== config.merchantId) return null
  return { token, merchantId: config.merchantId, capturedAt: captured, expiresAt: captured + attributionLifetimeMs }
}
