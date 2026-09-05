export type AttachmentLike = {
  filename?: string
  contentType?: string
  mimeType?: string
  type?: string
  content?: string
  data?: string
  base64?: string
  size?: number
}

export type AttachmentPanBounds = {
  stageWidth: number
  stageHeight: number
  imageWidth: number
  imageHeight: number
}

export type AttachmentPreviewState = 'loading' | 'ready' | 'error'
export type GalleryAttachmentSource = 'legacy' | 'r2'
export type GalleryAttachmentStatus = 'pending' | 'ready' | 'failed' | 'deleted'
export type AttachmentPickerMode = 'camera' | 'video' | 'gallery' | 'file'
export type GalleryUploadFailureAction = 'retry' | 'choose-again' | 'remove'

export type GalleryAttachment = {
  id: string
  source: GalleryAttachmentSource
  displayName: string
  filename: string
  mimeType: string
  kind: string
  sizeBytes: number
  status: GalleryAttachmentStatus | string
  createdAt: string
  legacy?: AttachmentLike
}

export type GalleryUploadState = 'validating' | 'creating' | 'uploading' | 'finalizing' | 'failed' | 'canceled' | 'complete'
export type GalleryUploadItem = {
  id: string
  file?: File
  fileName: string
  progress: number
  state: GalleryUploadState
  attachmentId?: string
  idempotencyKey: string
  error?: string
  failureAction?: GalleryUploadFailureAction
  pickerMode?: AttachmentPickerMode
}

export const maxGalleryAttachmentsPerJob = 50
export const allowedAttachmentMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

const attachmentMaxBytesByKind = {
  image: 15 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  document: 25 * 1024 * 1024,
}

export function attachmentPreviewStateForImageEvent(event: 'load' | 'error', hasObjectUrl: boolean) {
  if (!hasObjectUrl || event === 'error') return 'error'
  return 'ready'
}

export function stripDataUrlPrefix(value: string) {
  return value.includes(',') && value.trim().startsWith('data:') ? value.split(',').pop() || '' : value
}

export function base64ToBytes(value: string) {
  try {
    const binary = atob(stripDataUrlPrefix(value))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return new Uint8Array()
  }
}

export function inferAttachmentMimeType(value: string, filename = '') {
  return (
    inferMimeTypeFromDataUrl(value) ||
    inferMimeTypeFromFilename(filename) ||
    inferMimeTypeFromBytes(base64ToBytes(value))
  )
}

export function resolveAttachmentContentType(attachment: AttachmentLike, allowLegacyImageFallback = true) {
  const explicitType = String(attachment.contentType || attachment.mimeType || attachment.type || '').trim()
  if (explicitType) return explicitType

  const rawContent = String(attachment.content || attachment.data || attachment.base64 || '')
  const inferred = inferAttachmentMimeType(rawContent, String(attachment.filename || ''))
  if (inferred) return inferred

  return allowLegacyImageFallback && rawContent ? 'image/jpeg' : 'application/octet-stream'
}

export function attachmentToObjectUrl(
  attachment: AttachmentLike,
  createObjectUrl: (blob: Blob) => string = URL.createObjectURL.bind(URL),
) {
  const contentType = resolveAttachmentContentType(attachment)
  if (!contentType.startsWith('image/')) return ''

  const bytes = base64ToBytes(String(attachment.content || attachment.data || attachment.base64 || ''))
  if (!bytes.length) return ''

  return createObjectUrl(new Blob([bytes], { type: contentType }))
}

export function safeAttachmentDownloadUrl(attachment: AttachmentLike) {
  const contentType = resolveAttachmentContentType(attachment, false)
  return `data:${contentType};base64,${stripDataUrlPrefix(String(attachment.content || attachment.data || attachment.base64 || ''))}`
}

export function normalizeGalleryAttachments(
  legacyAttachments: AttachmentLike[],
  r2Attachments: Array<Partial<GalleryAttachment> & Record<string, unknown>> = [],
) {
  const legacy = legacyAttachments
    .filter((attachment) => String(attachment.content || attachment.data || attachment.base64 || '').trim())
    .map((attachment, index): GalleryAttachment => ({
      id: `legacy:${index}`,
      source: 'legacy',
      displayName: String(attachment.filename || 'Legacy attachment'),
      filename: String(attachment.filename || 'Legacy attachment'),
      mimeType: resolveAttachmentContentType(attachment),
      kind: 'image',
      sizeBytes: Number(attachment.size || 0),
      status: 'ready',
      createdAt: '',
      legacy: attachment,
    }))

  const r2 = r2Attachments
    .map((attachment): GalleryAttachment => ({
      id: String(attachment.id || ''),
      source: 'r2',
      displayName: String(attachment.displayName || attachment.display_name || attachment.original_filename || 'Attachment'),
      filename: String(attachment.filename || attachment.original_filename || attachment.displayName || attachment.display_name || 'Attachment'),
      mimeType: String(attachment.mimeType || attachment.mime_type || 'application/octet-stream'),
      kind: String(attachment.kind || 'document'),
      sizeBytes: Number(attachment.sizeBytes || attachment.size_bytes || 0),
      status: String(attachment.status || attachment.upload_status || 'pending'),
      createdAt: String(attachment.createdAt || attachment.created_at || ''),
    }))
    .filter((attachment) => attachment.id && attachment.status === 'ready')
    .sort((left, right) => compareAttachmentDates(right.createdAt, left.createdAt) || left.id.localeCompare(right.id))

  return [...r2, ...legacy]
}

export function activeAttachmentCount(legacyAttachments: AttachmentLike[], r2Attachments: Array<Partial<GalleryAttachment> & Record<string, unknown>> = []) {
  return normalizeGalleryAttachments(legacyAttachments, r2Attachments).length
}

export function attachmentCountLabel(count: number) {
  if (count === 0) return 'No attachments'
  if (count === 1) return '1 attachment'
  return `${count} attachments`
}

export function attachmentDateLabel(value: string) {
  if (!value) return 'Legacy attachment'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Legacy attachment'
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function validateGalleryFile(file: Pick<File, 'name' | 'size' | 'type'>, activeCount: number) {
  if (activeCount >= maxGalleryAttachmentsPerJob) return 'Attachment limit reached'
  if (!file.size) return 'Unsupported file type'

  const mimeType = resolveGalleryFileMimeType(file)
  const extension = String(file.name || '').toLowerCase().split('.').pop() || ''
  if (mimeType === 'text/html' || mimeType === 'image/svg+xml' || extension === 'html' || extension === 'htm' || extension === 'svg') {
    return 'Unsupported file type'
  }
  if (!allowedAttachmentMimeTypes.has(mimeType)) return 'Unsupported file type'

  const kind = attachmentKindForMimeType(mimeType)
  if (file.size > attachmentMaxBytesByKind[kind]) return 'File is too large'
  return ''
}

export function resolveGalleryFileMimeType(file: Pick<File, 'name' | 'type'>) {
  const explicitType = String(file.type || '').trim().toLowerCase()
  if (explicitType && explicitType !== 'application/octet-stream') return explicitType
  return inferMimeTypeFromFilename(String(file.name || '')).toLowerCase() || explicitType
}

export function shouldFetchSignedUrl(attachment: GalleryAttachment, now: number, cache?: { expiresAt: number; objectUrl: string }) {
  if (attachment.source !== 'r2') return false
  if (attachment.status !== 'ready') return false
  if (!cache) return true
  return cache.expiresAt - now < 30000
}

export function updateUploadProgress(upload: GalleryUploadItem, state: GalleryUploadState, progress = upload.progress, error = ''): GalleryUploadItem {
  return {
    ...upload,
    state,
    progress: clampNumber(progress, 0, 100),
    error,
  }
}

export function isAttachmentFileReadError(error: unknown) {
  const name = error instanceof Error ? error.name.toLowerCase() : ''
  const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase()
  return (
    name === 'notreadableerror' ||
    name === 'securityerror' ||
    message.includes('could not be read') ||
    message.includes('permission') ||
    message.includes('not readable') ||
    message.includes('security')
  )
}

export function attachmentUploadFailureMessage(error: unknown) {
  if (isAttachmentFileReadError(error)) {
    return 'The selected file is no longer readable. Choose it again to upload.'
  }
  return error instanceof Error ? error.message : 'Upload failed. Try again'
}

export function attachmentUploadFailureAction(error: unknown, sessionCreated: boolean): GalleryUploadFailureAction {
  if (!sessionCreated && isAttachmentFileReadError(error)) return 'choose-again'
  return 'retry'
}

export function normalizeAttachmentRotation(value: number) {
  if (!Number.isFinite(value)) return 0
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180
  return normalized === -180 ? 180 : normalized
}

export function constrainAttachmentPan(
  pan: { x: number; y: number },
  zoom: number,
  bounds: AttachmentPanBounds,
  rotation = 0,
) {
  const safeZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1)
  const rotated = rotatedContainedImageSize(bounds, rotation)
  const maxX = Math.max(0, (rotated.width * safeZoom - bounds.stageWidth) / 2)
  const maxY = Math.max(0, (rotated.height * safeZoom - bounds.stageHeight) / 2)
  return {
    x: clampNumber(pan.x, -maxX, maxX),
    y: clampNumber(pan.y, -maxY, maxY),
  }
}

export function rotatedContainedImageSize(bounds: AttachmentPanBounds, rotation = 0) {
  const fit = containImageSize(bounds)
  const radians = (normalizeAttachmentRotation(rotation) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return {
    width: roundAttachmentDimension(fit.width * cos + fit.height * sin),
    height: roundAttachmentDimension(fit.width * sin + fit.height * cos),
  }
}

export function pointerDistance(first: { x: number; y: number }, second: { x: number; y: number }) {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

export function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function inferMimeTypeFromDataUrl(value: string) {
  const match = value.match(/^data:([^;,]+)[;,]/)
  return match?.[1] || ''
}

function inferMimeTypeFromFilename(filename: string) {
  const extension = filename.trim().toLowerCase().split('.').pop()
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'heic') return 'image/heic'
  if (extension === 'heif') return 'image/heif'
  return ''
}

function attachmentKindForMimeType(mimeType: string): 'image' | 'video' | 'document' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  return 'document'
}

function compareAttachmentDates(left: string, right: string) {
  const leftTime = new Date(left).getTime()
  const rightTime = new Date(right).getTime()
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0
  if (Number.isNaN(leftTime)) return -1
  if (Number.isNaN(rightTime)) return 1
  return leftTime - rightTime
}

function inferMimeTypeFromBytes(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6))
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4))
    const webp = String.fromCharCode(...bytes.slice(8, 12))
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return ''
}

function containImageSize(bounds: AttachmentPanBounds) {
  const stageWidth = Math.max(0, bounds.stageWidth)
  const stageHeight = Math.max(0, bounds.stageHeight)
  const imageWidth = Math.max(0, bounds.imageWidth)
  const imageHeight = Math.max(0, bounds.imageHeight)
  if (!stageWidth || !stageHeight || !imageWidth || !imageHeight) return { width: 0, height: 0 }

  const scale = Math.min(stageWidth / imageWidth, stageHeight / imageHeight)
  return {
    width: imageWidth * scale,
    height: imageHeight * scale,
  }
}

function roundAttachmentDimension(value: number) {
  return Math.round(value * 1000) / 1000
}
