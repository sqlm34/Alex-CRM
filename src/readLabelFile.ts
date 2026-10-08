// Retry only local reads: never repeat a paid scan or create an attachment.
export async function readLabelFile(file: File): Promise<File> {
  if (file.size > 10000000) throw new Error('Choose a label photo under 10 MB')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bytes = await file.arrayBuffer()
      if (!bytes.byteLength) throw new Error('The selected photo is empty. Choose the original photo again.')
      return new File([bytes], file.name || 'label.jpg', { type: file.type, lastModified: file.lastModified })
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NotReadableError') throw error
      if (attempt === 2) throw new Error('The phone could not read this photo. Download it to the phone, then choose it again from Gallery, or use Scan label.', { cause: error })
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  throw new Error('Unable to read photo')
}
