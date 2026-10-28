import { readLabelFile } from './readLabelFile'
import { compatibleImageFile } from './heicImages'
import { resolveGalleryFileMimeType } from './attachmentUtils'
export async function inventoryPhoto(original:File,maxDimension=1000) {
  if(original.size>10000000)throw new Error('Choose a photo under 10 MB')
  const bytes=await readLabelFile(original,'receipt')
  const file=await compatibleImageFile(new File([bytes],original.name||'photo.jpg',{type:resolveGalleryFileMimeType(original)||original.type}))
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPG, PNG, WebP or HEIC photo')
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'})
  try{
    const scale=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height))
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale))
    const context=canvas.getContext('2d');if(!context)throw new Error('Image conversion unavailable')
    context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height)
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Unable to prepare photo')),'image/jpeg',.88))
  }finally{bitmap.close()}
}
