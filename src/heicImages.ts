// Serialize decoding to avoid several full-resolution iPhone photos exhausting mobile memory.
let decoding: Promise<unknown> = Promise.resolve()

export async function compatibleImageBlob(blob: Blob, filename = ''): Promise<Blob> {
  const bytes = new Uint8Array(await blob.slice(0, 256).arrayBuffer())
  if (bytes[0] === 0xff && bytes[1] === 0xd8 || bytes[0] === 0x89 && bytes[1] === 0x50) return blob
  const header = String.fromCharCode(...bytes)
  const brands = header.slice(8)
  const isHeic = header.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(brands) && !/avif|avis/.test(brands)
  if (!isHeic && !/^image\/(heic|heif)(-sequence)?$/i.test(blob.type) && !/\.hei[cf]$/i.test(filename)) return blob
  const task = decoding.then(async () => {
    try {
      const { heicTo } = await import('heic-to/csp')
      return await heicTo({ blob, type: 'image/jpeg', quality: 0.92 })
    } catch {
      throw new Error('Unable to convert this HEIC photo. Please choose the original photo again or export it as JPEG.')
    }
  })
  decoding = task.catch(() => undefined)
  return task
}

export async function compatibleImageFile(file: File): Promise<File> {
  const blob = await compatibleImageBlob(file, file.name)
  if (blob === file) return file
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, {
    type: 'image/jpeg', lastModified: file.lastModified,
  })
}
