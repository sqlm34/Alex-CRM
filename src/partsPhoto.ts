import { Capacitor, registerPlugin } from '@capacitor/core'

interface PhotoResult { cancelled?: boolean; base64?: string; mimeType?: string }
const nativePhoto = registerPlugin<{ pick(options: { source: 'camera' | 'gallery' }): Promise<PhotoResult> }>('PartsPhoto')

export function hasNativePartsPhoto() {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('PartsPhoto')
}

export function nativePhotoFile(photo: PhotoResult): File | null {
  if (photo.cancelled) return null
  if (!photo.base64 || photo.base64.length > 13333336) throw new Error('Choose a label photo under 10 MB')
  const binary = atob(photo.base64)
  if (!binary.length || binary.length > 10000000) throw new Error('Choose a label photo under 10 MB')
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const mime = photo.mimeType || 'application/octet-stream'
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[mime] || 'img'
  return new File([bytes], `label.${extension}`, { type: mime })
}

export async function pickPartsPhoto(source: 'camera' | 'gallery'): Promise<File | null> {
  try { return nativePhotoFile(await nativePhoto.pick({ source })) }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'PHOTO_TOO_LARGE') throw new Error('Choose a label photo under 10 MB', { cause: error })
    if (message === 'PHOTO_PICKER_UNAVAILABLE') throw new Error('The camera or gallery could not open. Please try again.', { cause: error })
    if (message === 'PHOTO_READ_FAILED') throw new Error('Android could not read this photo. Check that the original photo is available on the phone.', { cause: error })
    throw error
  }
}
