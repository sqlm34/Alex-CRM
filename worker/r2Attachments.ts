export type AttachmentKind = 'image' | 'video' | 'document'

export type AttachmentUploadInput = {
  filename?: unknown
  mime_type?: unknown
  mimeType?: unknown
  size_bytes?: unknown
  sizeBytes?: unknown
  checksum?: unknown
  idempotency_key?: unknown
  idempotencyKey?: unknown
}

export type NormalizedAttachmentUpload = {
  originalFilename: string
  displayName: string
  extension: string
  mimeType: string
  kind: AttachmentKind
  sizeBytes: number
  checksum: string | null
  idempotencyKey: string | null
}

export type R2PresignOptions = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
  key: string
  method: 'GET' | 'HEAD' | 'PUT' | 'DELETE'
  expiresSeconds: number
  headers?: Record<string, string>
  now?: Date
}

export const maxAttachmentFilesPerJob = 50
export const attachmentViewUrlTtlSeconds = 5 * 60
export const attachmentUploadUrlTtlSeconds = 10 * 60

const maxBytesByKind: Record<AttachmentKind, number> = {
  image: 15 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  document: 25 * 1024 * 1024,
}

const documentMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

export function normalizeAttachmentUploadInput(input: AttachmentUploadInput): NormalizedAttachmentUpload {
  const originalFilename = sanitizeAttachmentFilename(String(input.filename || 'Mobile upload'))
  const mimeType = normalizeAttachmentMimeType(String(input.mime_type || input.mimeType || ''))
  const kind = attachmentKindForMimeType(mimeType)
  const sizeBytes = normalizeAttachmentSize(input.size_bytes ?? input.sizeBytes, kind)
  const checksum = normalizeOptionalToken(input.checksum, 128)
  const idempotencyKey = normalizeOptionalToken(input.idempotency_key ?? input.idempotencyKey, 120)

  return {
    originalFilename,
    displayName: originalFilename || 'Mobile upload',
    extension: attachmentExtension(originalFilename, mimeType),
    mimeType,
    kind,
    sizeBytes,
    checksum,
    idempotencyKey,
  }
}

export function createPendingAttachmentObjectKey(jobId: string, attachmentId: string, extension: string) {
  return `pending/${attachmentObjectKeyTail(jobId, attachmentId, extension)}`
}

export function createPermanentAttachmentObjectKey(jobId: string, attachmentId: string, extension: string) {
  return attachmentObjectKeyTail(jobId, attachmentId, extension)
}

export function createDeletedAttachmentObjectKey(jobId: string, attachmentId: string, extension: string) {
  return `deleted/${attachmentObjectKeyTail(jobId, attachmentId, extension)}`
}

export function extensionFromObjectKey(objectKey: string) {
  return objectKey.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] || 'bin'
}

function attachmentObjectKeyTail(jobId: string, attachmentId: string, extension: string) {
  const safeJobId = String(jobId || 'job').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'job'
  const safeAttachmentId = String(attachmentId || crypto.randomUUID()).replace(/[^A-Za-z0-9-]/g, '-')
  const safeExtension = extension.replace(/[^a-z0-9]/g, '') || 'bin'
  return `jobs/${safeJobId}/${safeAttachmentId}/original.${safeExtension}`
}

export function publicAttachmentMetadata(row: Record<string, unknown>) {
  return {
    id: String(row.id || ''),
    source: 'r2',
    job_id: String(row.job_id || ''),
    display_name: String(row.display_name || row.original_filename || 'Mobile upload'),
    original_filename: String(row.original_filename || ''),
    mime_type: String(row.mime_type || 'application/octet-stream'),
    kind: String(row.kind || 'document'),
    size_bytes: Number(row.size_bytes || 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    upload_status: String(row.upload_status || 'pending'),
    created_at: String(row.created_at || ''),
    deleted_at: row.deleted_at || null,
  }
}

export function legacyAttachmentMetadata(jobId: string, attachment: Record<string, unknown>, index: number) {
  return {
    id: `legacy:${jobId}:${index}`,
    source: 'legacy',
    job_id: jobId,
    display_name: String(attachment.filename || 'Mobile upload'),
    original_filename: String(attachment.filename || ''),
    mime_type: String(attachment.contentType || attachment.mimeType || attachment.type || 'image/jpeg'),
    kind: 'image',
    size_bytes: Number(attachment.size || 0),
    width: null,
    height: null,
    duration_ms: null,
    upload_status: 'ready',
    created_at: '',
    deleted_at: null,
  }
}

export async function createR2PresignedUrl(options: R2PresignOptions) {
  const now = options.now || new Date()
  const amzDate = toAmzDate(now)
  const shortDate = amzDate.slice(0, 8)
  const credentialScope = `${shortDate}/auto/s3/aws4_request`
  const host = `${options.accountId}.r2.cloudflarestorage.com`
  const canonicalUri = `/${encodePathSegment(options.bucketName)}/${encodeR2Key(options.key)}`
  const signedHeaderValues = normalizeSignedHeaders({ host, ...(options.headers || {}) })
  const signedHeaders = Object.keys(signedHeaderValues).sort().join(';')
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${options.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(options.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  })
  const canonicalQuery = canonicalQueryString(params)
  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    Object.keys(signedHeaderValues)
      .sort()
      .map((header) => `${header}:${signedHeaderValues[header]}`)
      .join('\n'),
    '',
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = await r2SigningKey(options.secretAccessKey, shortDate)
  const signature = bytesToHex(new Uint8Array(await hmac(signingKey, stringToSign)))
  params.set('X-Amz-Signature', signature)

  return `https://${host}${canonicalUri}?${params.toString()}`
}

export function attachmentKindForMimeType(mimeType: string): AttachmentKind {
  const normalized = normalizeAttachmentMimeType(mimeType)
  if (normalized.startsWith('image/') && normalized !== 'image/svg+xml') return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (documentMimeTypes.has(normalized)) return 'document'
  throw new Error('Unsupported attachment file type')
}

export function validateAttachmentSignature(mimeType: string, extension: string, bytes: Uint8Array) {
  const normalized = normalizeAttachmentMimeType(mimeType)
  const ext = extension.toLowerCase()
  if (normalized === 'image/svg+xml' || ext === 'svg' || normalized === 'text/html' || ext === 'html' || ext === 'htm') {
    throw new Error('Attachment type is not allowed')
  }
  attachmentKindForMimeType(normalized)

  if (normalized === 'image/jpeg' && !hasPrefix(bytes, [0xff, 0xd8, 0xff])) throw new Error('Attachment file signature does not match MIME type')
  if (normalized === 'image/png' && !hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47])) throw new Error('Attachment file signature does not match MIME type')
  if (normalized === 'image/gif' && !startsWithAscii(bytes, 'GIF87a') && !startsWithAscii(bytes, 'GIF89a')) throw new Error('Attachment file signature does not match MIME type')
  if (normalized === 'image/webp' && (!startsWithAscii(bytes, 'RIFF') || asciiAt(bytes, 8, 12) !== 'WEBP')) throw new Error('Attachment file signature does not match MIME type')
  if (normalized === 'application/pdf' && !startsWithAscii(bytes, '%PDF-')) throw new Error('Attachment file signature does not match MIME type')
  if (normalized.startsWith('video/') && bytes.length && !looksLikeMp4(bytes)) throw new Error('Attachment file signature does not match MIME type')
}

function normalizeAttachmentMimeType(value: string) {
  const mimeType = value.trim().toLowerCase()
  if (!mimeType || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) {
    throw new Error('Valid attachment MIME type is required')
  }
  return mimeType
}

function normalizeAttachmentSize(value: unknown, kind: AttachmentKind) {
  const sizeBytes = Number(value)
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Valid attachment size is required')
  if (sizeBytes > maxBytesByKind[kind]) throw new Error(`${kind} attachment is too large`)
  return sizeBytes
}

function sanitizeAttachmentFilename(value: string) {
  const cleaned = value
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
  return cleaned.slice(0, 180) || 'Mobile upload'
}

function attachmentExtension(filename: string, mimeType: string) {
  const fromFilename = filename.toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1]
  if (fromFilename) return fromFilename
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/heic') return 'heic'
  if (mimeType === 'video/mp4') return 'mp4'
  if (mimeType === 'video/quicktime') return 'mov'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === 'text/plain') return 'txt'
  return 'bin'
}

function normalizeOptionalToken(value: unknown, maxLength: number) {
  const text = String(value || '').trim()
  if (!text) return null
  return text.replace(/[^\x20-\x7E]/g, '').slice(0, maxLength)
}

function encodeR2Key(key: string) {
  return key.split('/').map(encodePathSegment).join('/')
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalQueryString(params: URLSearchParams) {
  return [...params.entries()]
    .map(([key, value]) => [encodePathSegment(key), encodePathSegment(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

function normalizeSignedHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value).trim().replace(/\s+/g, ' '),
    ]),
  )
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

async function r2SigningKey(secretAccessKey: string, shortDate: string) {
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), shortDate)
  const regionKey = await hmac(dateKey, 'auto')
  const serviceKey = await hmac(regionKey, 's3')
  return hmac(serviceKey, 'aws4_request')
}

async function hmac(keyData: BufferSource, value: string) {
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(hash))
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hasPrefix(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function startsWithAscii(bytes: Uint8Array, value: string) {
  return asciiAt(bytes, 0, value.length) === value
}

function asciiAt(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end))
}

function looksLikeMp4(bytes: Uint8Array) {
  return asciiAt(bytes, 4, 8) === 'ftyp'
}
