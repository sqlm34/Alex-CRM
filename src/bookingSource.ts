export type BookingSource = 'google_maps' | 'google' | 'website'
export const bookingSourceLabels: Record<BookingSource, string> = {
  google_maps: 'Google Maps', google: 'Google', website: 'Website',
}
export const attributionLifetimeMs = 30 * 24 * 60 * 60 * 1000
export const attributionStorageKey = 'alex-booking-source-v1'
type Attribution = { source: BookingSource; capturedAt: number }

export function normalizeBookingSource(value: unknown): BookingSource | null {
  return value === 'google_maps' || value === 'google' || value === 'website' ? value : null
}

function parseUrl(value: string) {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null } catch { return null }
}

export function resolveBookingAttribution(href: string, referrer: string, stored: unknown, now: number): Attribution {
  const url = parseUrl(href), ref = parseUrl(referrer)
  const host = (value: URL) => value.hostname.toLowerCase().replace(/^www\./, '')
  const internal = Boolean(url && ref && host(url) === host(ref))
  const params = url?.searchParams
  const source = params?.get('utm_source')?.trim().toLowerCase()
  const campaign = params?.get('utm_campaign')?.trim().toLowerCase()
  const googleRef = ref && /(^|\.)google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(ref.hostname)
  let detected: BookingSource | null = null
  // Internal navigation must not refresh attribution or its 30-day expiry.
  if (!internal) {
    if (source === 'google' && campaign === 'google_maps') detected = 'google_maps'
    else if (source === 'google' || ['gclid', 'gbraid', 'wbraid'].some(key => params?.get(key)?.trim()) || googleRef) detected = 'google'
    else if (ref || source || params?.get('utm_medium') || campaign) detected = 'website'
  }
  if (detected) return { source: detected, capturedAt: now }
  const previous = stored as Partial<Attribution> | null
  if (normalizeBookingSource(previous?.source) && typeof previous?.capturedAt === 'number' &&
      Number.isFinite(previous.capturedAt) && previous.capturedAt <= now && now - previous.capturedAt < attributionLifetimeMs) {
    return { source: previous.source!, capturedAt: previous.capturedAt }
  }
  return { source: 'website', capturedAt: now }
}

let memory: Attribution | null = null
export function captureBookingAttribution(navigationType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type) {
  let stored: unknown = memory
  try { stored = JSON.parse(localStorage.getItem(attributionStorageKey) || 'null') ?? memory } catch { /* Storage may be blocked. */ }
  const replay = navigationType === 'reload' || navigationType === 'back_forward'
  memory = resolveBookingAttribution(replay ? window.location.origin : window.location.href, replay ? '' : document.referrer, stored, Date.now())
  try { localStorage.setItem(attributionStorageKey, JSON.stringify(memory)) } catch { /* Keep this page's attribution in memory. */ }
}

export function currentBookingSource(): BookingSource {
  let stored: unknown = memory
  try { stored = JSON.parse(localStorage.getItem(attributionStorageKey) || 'null') ?? memory } catch { /* Use memory. */ }
  // Submission reads the stored attribution without replaying the original referrer.
  return resolveBookingAttribution(window.location.origin, '', stored, Date.now()).source
}
