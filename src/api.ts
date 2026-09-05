import type { JobListRow, JobRow, PriceBookItemRow } from './supabase'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined

export const isApiConfigured = Boolean(apiUrl)
export const configuredApiUrl = apiUrl

export type AuthUser = {
  id: string
  email: string
  name: string
  provider: string
  role: 'owner' | 'technician'
  phone?: string | null
}

export type AuthSession = {
  token: string
  user: AuthUser
}

export type TwoFactorChallenge = {
  requiresTwoFactor: true
  challengeId: string
  maskedPhone: string
  expiresInSeconds: number
}

export type PendingApprovalResponse = {
  pendingApproval: true
  email: string
  message: string
}

export type AuthLoginResponse = AuthSession | TwoFactorChallenge | PendingApprovalResponse

export type ApprovedUser = {
  user_id?: string | null
  email: string
  role: 'owner' | 'technician'
  name?: string | null
  phone?: string | null
  invited_by_user_id?: string | null
  created_at?: string
  online_until?: string | null
  now_online?: boolean
  approved?: boolean
}

export type PublicBookingPayload = {
  session_id?: string
  customer: string
  phone: string
  email?: string
  address: string
  appliance: string
  issue?: string
  details?: string
  job_text?: string
  model_photo_names?: string[]
  model_photos?: File[]
  model_photo_attachments?: PublicBookingPhotoAttachment[]
  service_date: string
  service_window: string
  lat?: number
  lng?: number
  device_id?: string
  started_at?: number
  website?: string
}

export type PublicBookingPhotoAttachment = {
  filename: string
  contentType: string
  content: string
  size: number
}

export type JobAttachmentSource = 'r2' | 'legacy'
export type JobAttachmentKind = 'image' | 'video' | 'document'
export type JobAttachmentStatus = 'pending' | 'ready' | 'failed' | 'deleted'

export type JobAttachmentMetadata = {
  id: string
  source: JobAttachmentSource
  job_id: string
  display_name: string
  original_filename: string
  mime_type: string
  kind: JobAttachmentKind | string
  size_bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  upload_status: JobAttachmentStatus | string
  created_at: string
  deleted_at: string | null
}

export type JobAttachmentsResponse = {
  attachments: JobAttachmentMetadata[]
}

export type CreateAttachmentUploadPayload = {
  filename: string
  mimeType: string
  sizeBytes: number
  checksum?: string | null
  idempotencyKey?: string | null
}

export type AttachmentUploadSession = {
  attachment: JobAttachmentMetadata
  upload: {
    method: 'PUT'
    url: string
    expires_in_seconds: number
    headers: Record<string, string>
  }
}

export type AttachmentViewUrlResponse = {
  url: string
  expires_in_seconds: number
}

export type BookingConfig = {
  turnstileSiteKey: string
  smsRequired: boolean
}

export type BookingAvailability = {
  date: string
  bookedWindows: string[]
}

export type AvailabilityBlock = {
  id: string
  blocked_date: string
  service_window?: string | null
  all_day: boolean
  reason?: string | null
  created_at?: string
}

export type BookingStartResponse = {
  sessionId: string
  riskScore: number
  decision: 'ACCEPT' | 'REVIEW' | 'BLOCK'
}

export type BookingOtpResponse = {
  challengeId: string
  maskedPhone: string
  expiresInSeconds: number
  smsUnavailable?: boolean
}

export type BookingVerifyResponse = {
  ok: true
  phoneVerified: true
}

export type PriceBookItemInput = {
  name: string
  description?: string
  category?: string
  unit_price_cents: number
  taxable: boolean
  active: boolean
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function normalizeApiDate(value: unknown) {
  const text = String(value || '').trim()
  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`

  const usDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (usDate) return `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`

  const monthDate = text
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .match(/^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i)
  if (monthDate) {
    const month = monthNameToNumber(monthDate[1])
    if (month) return `${monthDate[3]}-${month}-${monthDate[2].padStart(2, '0')}`
  }

  return text
}

function monthNameToNumber(value: string) {
  const month = value.toLowerCase().slice(0, 3)
  const index = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(month)
  return index === -1 ? '' : String(index + 1).padStart(2, '0')
}

function normalizeJobRow<T extends JobRow | JobListRow>(row: T): T {
  return {
    ...row,
    service_date: normalizeApiDate(row.service_date),
    service_window: String(row.service_window || ''),
  }
}

async function parseApiError(response: Response, fallback: string) {
  let message = fallback

  try {
    const data = (await response.json()) as { error?: string }
    if (data.error) message = data.error
  } catch {
    // Keep the fallback message.
  }

  return new ApiError(message, response.status)
}

export async function fetchJobsFromApi(token?: string, signal?: AbortSignal) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, {
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to load jobs')

  return ((await response.json()) as JobListRow[]).map(normalizeJobRow)
}

export async function fetchJobFromApi(id: string, token?: string, signal?: AbortSignal) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}?_=${Date.now()}`, {
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to load job')

  return normalizeJobRow((await response.json()) as JobRow)
}

export async function saveJobToApi(job: JobRow, token?: string) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(job),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to save job')

  return normalizeJobRow((await response.json()) as JobRow)
}

export async function createPublicBooking(booking: PublicBookingPayload) {
  if (!apiUrl) throw new Error('API is not configured')

  const { model_photos: modelPhotos, ...bookingFields } = booking
  const attachments = modelPhotos?.length ? await filesToBookingPhotoAttachments(modelPhotos) : []
  const body = JSON.stringify({
    ...bookingFields,
    model_photo_names: attachments.length ? attachments.map((photo) => photo.filename) : bookingFields.model_photo_names,
    model_photo_attachments: attachments,
  })

  const response = await fetch(`${apiUrl}/api/public/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to book appointment')

  return normalizeJobRow((await response.json()) as JobRow)
}

async function filesToBookingPhotoAttachments(photos: File[]) {
  if (photos.length > 5) throw new Error('Upload no more than 5 model sticker photos')

  let totalSize = 0
  const attachments: PublicBookingPhotoAttachment[] = []
  for (const photo of photos) {
    totalSize += photo.size
    if (!photo.type.startsWith('image/')) throw new Error('Model sticker upload must be an image file')
    if (photo.size > 8 * 1024 * 1024) throw new Error('Each model sticker photo must be under 8 MB')
    if (totalSize > 16 * 1024 * 1024) throw new Error('Model sticker photos must be under 16 MB total')
    attachments.push({
      filename: photo.name || 'model-sticker.jpg',
      contentType: photo.type || 'application/octet-stream',
      content: await fileToBase64(photo),
      size: photo.size,
    })
  }
  return attachments
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',').pop() || '' : result)
    }
    reader.onerror = () => reject(new Error('Unable to read model sticker photo'))
    reader.readAsDataURL(file)
  })
}

export async function fetchBookingConfig() {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/public/booking/config`, {
    cache: 'no-store',
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load booking settings')

  return (await response.json()) as BookingConfig
}

export async function fetchBookingAvailability(date: string, signal?: AbortSignal) {
  if (!apiUrl) throw new Error('API is not configured')

  const params = new URLSearchParams({
    date,
    _: String(Date.now()),
  })

  const response = await fetch(`${apiUrl}/api/public/booking/availability?${params.toString()}`, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load booking availability')

  return (await response.json()) as BookingAvailability
}

export async function startPublicBooking(payload: {
  device_id: string
  started_at: number
  website?: string
  turnstile_token?: string
  referrer?: string
  source?: string
}) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/public/booking/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to start booking')

  return (await response.json()) as BookingStartResponse
}

export async function sendPublicBookingOtp(sessionId: string, phone: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/public/booking/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, phone }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to send SMS code')

  return (await response.json()) as BookingOtpResponse
}

export async function verifyPublicBookingOtp(sessionId: string, challengeId: string, code: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/public/booking/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, challengeId, code }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to verify SMS code')

  return (await response.json()) as BookingVerifyResponse
}

export async function updateJobInApi(
  id: string,
  patch: Partial<Pick<JobRow, 'customer' | 'phone' | 'email' | 'address' | 'appliance' | 'issue' | 'details' | 'job_text' | 'paid' | 'status' | 'invoice' | 'finance_items' | 'payments' | 'model_photo_attachments' | 'service_date' | 'service_window' | 'created_by_user_id'>>,
  token?: string,
) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(patch),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to update job')

  return normalizeJobRow((await response.json()) as JobRow)
}

export async function fetchPriceBookItems(token?: string, signal?: AbortSignal) {
  if (!apiUrl) return [] as PriceBookItemRow[]

  const response = await fetch(`${apiUrl}/api/price-book`, {
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load price book')
  return (await response.json()) as PriceBookItemRow[]
}

export async function createPriceBookItem(payload: PriceBookItemInput, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/price-book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to save price book item')
  return (await response.json()) as PriceBookItemRow
}

export async function updatePriceBookItem(id: string, payload: Partial<PriceBookItemInput>, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/price-book/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to update price book item')
  return (await response.json()) as PriceBookItemRow
}

export async function fetchJobAttachments(jobId: string, token?: string, signal?: AbortSignal) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments`, {
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to load attachments')
  return (await response.json()) as JobAttachmentsResponse
}

export async function createAttachmentUploadSession(jobId: string, payload: CreateAttachmentUploadPayload, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({
      filename: payload.filename,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      checksum: payload.checksum || undefined,
      idempotencyKey: payload.idempotencyKey || undefined,
    }),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to prepare attachment upload')
  return (await response.json()) as AttachmentUploadSession
}

export async function completeAttachmentUpload(jobId: string, attachmentId: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(attachmentId)}/complete`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to finish attachment upload')
  return (await response.json()) as { attachment: JobAttachmentMetadata }
}

export async function fetchAttachmentViewUrl(jobId: string, attachmentId: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(attachmentId)}/url`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to open attachment')
  return (await response.json()) as AttachmentViewUrlResponse
}

export async function renameJobAttachment(jobId: string, attachmentId: string, displayName: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ display_name: displayName }),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to rename attachment')
  return (await response.json()) as { attachment: JobAttachmentMetadata }
}

export async function deleteJobAttachment(jobId: string, attachmentId: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(jobId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  if (!response.ok) throw await parseApiError(response, 'Unable to delete attachment')
  return (await response.json()) as { attachment: JobAttachmentMetadata }
}

export function uploadAttachmentFile(
  uploadUrl: string,
  file: File,
  options: {
    headers?: Record<string, string>
    signal?: AbortSignal
    timeoutMs?: number
    onProgress?: (progress: number) => void
  } = {},
) {
  return new Promise<{ etag: string | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const timeoutId = window.setTimeout(() => {
      xhr.abort()
      reject(new Error('Upload timed out. Try again'))
    }, options.timeoutMs || 120000)

    const cleanup = () => {
      window.clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', abort)
    }
    const abort = () => xhr.abort()
    options.signal?.addEventListener('abort', abort, { once: true })

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader('ETag') })
        return
      }
      reject(new Error('Upload failed. Try again'))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error('Upload failed. Try again'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new Error('Upload canceled'))
    }
    xhr.open('PUT', uploadUrl)
    xhr.withCredentials = false
    for (const [key, value] of Object.entries(options.headers || {})) {
      if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'content-length') continue
      xhr.setRequestHeader(key, value)
    }
    xhr.send(file)
  })
}

export async function fetchAvailabilityBlocks(token?: string) {
  if (!apiUrl || !token) return []

  const response = await fetch(`${apiUrl}/api/availability-blocks`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load time off')
  return (await response.json()) as AvailabilityBlock[]
}

export async function saveAvailabilityBlock(
  block: {
    blocked_date: string
    service_windows: string[]
    all_day: boolean
    reason?: string
  },
  token?: string,
) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/availability-blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(block),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to save time off')
  return (await response.json()) as AvailabilityBlock[]
}

export async function deleteAvailabilityBlock(id: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/availability-blocks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to delete time off')
}

export async function sendInvoiceEmail(id: string, token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/jobs/${encodeURIComponent(id)}/invoice/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to send invoice')

  return (await response.json()) as { ok: boolean; email: string }
}

export type StripeTerminalConfig = {
  ready: boolean
  locationId: string
  currency: string
}

export async function fetchStripeTerminalConfig(token?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/stripe/terminal/config`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load Stripe Terminal settings')
  return (await response.json()) as StripeTerminalConfig
}

export async function deleteJobFromApi(id: string, token?: string, orderNumber?: string) {
  if (!apiUrl) return

  const url = new URL(`${apiUrl}/api/jobs/${encodeURIComponent(id)}`)
  if (orderNumber) {
    url.searchParams.set('orderNumber', orderNumber)
  }

  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to delete job')
}

export async function registerPushToken(token: string, platform: string, authToken?: string) {
  if (!apiUrl) return
  if (!authToken) return

  const response = await fetch(`${apiUrl}/api/push-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(authToken) },
    body: JSON.stringify({ token, platform }),
  })

  if (!response.ok) throw new Error('Unable to register push token')
}

export async function loginWithPassword(
  email: string,
  password: string,
  options: { trustedDeviceId?: string; platform?: 'android' | 'web' } = {},
) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, trustedDeviceId: options.trustedDeviceId, platform: options.platform }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to sign in')

  return (await response.json()) as AuthLoginResponse
}

export async function requestSmsLogin(email: string, options: { platform?: 'android' | 'web' } = {}) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/request-sms-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, platform: options.platform }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to send SMS code')

  return (await response.json()) as TwoFactorChallenge
}

export async function registerWithPassword(
  name: string,
  email: string,
  password: string,
  options: { phone?: string; platform?: 'android' | 'web' } = {},
) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, phone: options.phone, platform: options.platform }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to register')

  return (await response.json()) as AuthLoginResponse
}

export async function loginWithGoogle(idToken: string, options: { ownerOnly?: boolean } = {}) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ownerOnly: options.ownerOnly }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to sign in with Google')

  return (await response.json()) as AuthSession
}

export async function verifySmsCode(challengeId: string, code: string, trustedDeviceId?: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/auth/verify-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, code, trustedDeviceId }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to verify code')

  return (await response.json()) as AuthSession
}

export async function fetchCurrentUser(token: string) {
  if (!apiUrl) return null

  const response = await fetch(`${apiUrl}/api/auth/me`, {
    cache: 'no-store',
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load profile')

  return (await response.json()) as AuthUser
}

export async function sendHeartbeat(token: string, signal?: AbortSignal) {
  if (!apiUrl) return

  const response = await fetch(`${apiUrl}/api/auth/heartbeat`, {
    method: 'POST',
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to update online status')
}

export async function sendOffline(token: string, options: { beacon?: boolean } = {}) {
  if (!apiUrl) return
  const offlineUrl = `${apiUrl}/api/auth/offline`

  if (options.beacon !== false && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(offlineUrl, new Blob([JSON.stringify({ token })], { type: 'text/plain' }))
    if (sent) return
  }

  const response = await fetch(offlineUrl, {
    method: 'POST',
    cache: 'no-store',
    keepalive: true,
    headers: authHeaders(token),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to update online status')
}

export async function fetchApprovedUsers(token: string, signal?: AbortSignal) {
  if (!apiUrl) return []

  const response = await fetch(`${apiUrl}/api/approved-users`, {
    cache: 'no-store',
    headers: authHeaders(token),
    signal,
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to load technicians')

  return (await response.json()) as ApprovedUser[]
}

export async function addApprovedUser(email: string, token: string) {
  if (!apiUrl) throw new Error('API is not configured')

  const response = await fetch(`${apiUrl}/api/approved-users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ email }),
  })

  if (!response.ok) throw await parseApiError(response, 'Unable to add technician')

  return (await response.json()) as ApprovedUser
}
