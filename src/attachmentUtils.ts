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
