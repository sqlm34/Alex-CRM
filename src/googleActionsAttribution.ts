export const googleActionsLifetimeMs = 30 * 24 * 60 * 60 * 1000
export const googleActionsStorageKey = 'alex-google-actions-attribution-v1'

export type GoogleActionsAttribution = {
  rwg_token?: string
  merchant_id?: string
  attribution_id?: string
  captured_at: number
  expires_at: number
}
export type GoogleActionsCapture = {
  rwg_token: string
  merchant_id?: string
  captured_at: number
}
export type GoogleActionsReceipt = {
  attribution_id: string
  captured_at: string
  expires_at: string
}

export function validGoogleActionsAttribution(value: unknown, now: number): GoogleActionsAttribution | null {
  if (!value || typeof value !== 'object') return null
  const item = value as GoogleActionsAttribution
  if (!Number.isSafeInteger(item.captured_at) || !Number.isSafeInteger(item.expires_at) ||
      item.captured_at > now || item.expires_at <= now ||
      item.expires_at !== item.captured_at + googleActionsLifetimeMs) return null
  if (item.merchant_id !== undefined && (typeof item.merchant_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.merchant_id))) return null
  if (typeof item.attribution_id === 'string' && /^[a-f0-9-]{36}$/i.test(item.attribution_id)) return item
  // Reject unsupported input in full; never silently truncate an attribution token.
  if (typeof item.rwg_token !== 'string' || !item.rwg_token || item.rwg_token.length > 16384 ||
      /[\s\ufffd]/.test(item.rwg_token) || [...item.rwg_token].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null
  return item
}

export function resolveGoogleActionsAttribution(href: string, stored: unknown, now: number): GoogleActionsAttribution | null {
  const previous = validGoogleActionsAttribution(stored, now)
  try {
    const url = new URL(href)
    if (!/^https?:$/.test(url.protocol) || !/^\/booking\/?$/.test(url.pathname)) return previous
    const tokens = url.searchParams.getAll('rwg_token')
    if (tokens.length !== 1) return previous
    const token = tokens[0]
    const merchant = url.searchParams.get('merchant_id') || undefined
    if (previous?.rwg_token === token && previous.merchant_id === merchant) return previous
    return validGoogleActionsAttribution({rwg_token: token, merchant_id: merchant,
      captured_at: now, expires_at: now + googleActionsLifetimeMs}, now) || previous
  } catch { return previous }
}

let memory: GoogleActionsAttribution | null = null
function read(now = Date.now()) {
  const local = validGoogleActionsAttribution(memory, now)
  try {
    const stored = localStorage.getItem(googleActionsStorageKey)
    const disk = validGoogleActionsAttribution(stored ? JSON.parse(stored) : null, now)
    if (stored && !disk) localStorage.removeItem(googleActionsStorageKey)
    if (!disk) return local
    if (!local) return disk
    if (disk.rwg_token === local.rwg_token && disk.merchant_id === local.merchant_id) {
      if (local.attribution_id) return local
      if (disk.attribution_id) return disk
    }
    if (disk.captured_at > local.captured_at) return disk
    if (disk.captured_at === local.captured_at && disk.attribution_id && !local.attribution_id) return disk
    return local
  } catch { return local }
}
function persist(item: GoogleActionsAttribution) {
  memory = item
  try {
    localStorage.setItem(googleActionsStorageKey, JSON.stringify(item))
    return true
  } catch { return false }
}

export function captureGoogleActionsAttribution() {
  const now = Date.now()
  memory = resolveGoogleActionsAttribution(window.location.href, read(now), now)
  if (!memory || !persist(memory)) return
  const url = new URL(window.location.href)
  if (/^\/booking\/?$/.test(url.pathname) && url.searchParams.has('rwg_token')) {
    url.searchParams.delete('rwg_token')
    // Preserve all unrelated query parameters and the router's history state.
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }
}

export function bookingReferrerWithoutGoogleToken(referrer: string) {
  if (!referrer) return ''
  try {
    const url = new URL(referrer)
    url.searchParams.delete('rwg_token')
    return url.toString()
  } catch { return '' }
}

const pending = new Map<string, Promise<string | undefined>>()
export function prepareGoogleActionsAttribution(enabled: boolean,
  capture: (payload: GoogleActionsCapture) => Promise<GoogleActionsReceipt | null>): Promise<string | undefined> {
  if (!enabled) return Promise.resolve(undefined)
  const item = read()
  if (!item) return Promise.resolve(undefined)
  if (item.attribution_id) return Promise.resolve(item.attribution_id)
  const key = JSON.stringify([item.rwg_token, item.merchant_id, item.captured_at])
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const request = (async () => {
    try {
      const receipt = await capture({rwg_token: item.rwg_token!, merchant_id: item.merchant_id, captured_at: item.captured_at})
      if (!receipt) return undefined
      const saved = validGoogleActionsAttribution({attribution_id: receipt.attribution_id, rwg_token: item.rwg_token, merchant_id: item.merchant_id,
        captured_at: Date.parse(receipt.captured_at), expires_at: Date.parse(receipt.expires_at)}, Date.now())
      if (!saved || saved.captured_at > item.captured_at) return undefined
      // Do not replace a newer referral while an older request is in flight.
      const current = read()
      if (current?.captured_at !== item.captured_at || current?.rwg_token !== item.rwg_token) {
        return prepareGoogleActionsAttribution(enabled, capture)
      }
      persist(saved)
      return saved.attribution_id
    } catch { return undefined } finally { pending.delete(key) }
  })()
  pending.set(key, request)
  return request
}
