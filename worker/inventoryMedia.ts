import type { NeonQueryFunction } from '@neondatabase/serverless'
import { recognizeReceipt } from './receiptRecognition'
import { validateAttachmentSignature } from './r2Attachments'
import { InventoryError } from './inventory'

type MediaEnv={ATTACHMENTS_BUCKET?:R2Bucket;ATTACHMENTS_R2_ENABLED?:string;OPENAI_API_KEY?:string;OPENAI_RECEIPT_MODEL?:string}
async function imageBytes(request:Request) {
  const type=request.headers.get('Content-Type')?.split(';')[0] || ''
  if(!['image/jpeg','image/png','image/webp'].includes(type))throw new InventoryError('Choose a JPG, PNG or WebP image')
  const reader=request.body?.getReader()
  if(!reader)throw new InventoryError('Image required')
  let length=0; const chunks:Uint8Array[]=[]
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>10000000)throw new InventoryError('Image must be under 10 MB');chunks.push(value)}}finally{await reader.cancel()}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  try{validateAttachmentSignature(type,type.split('/')[1],bytes)}catch{throw new InventoryError('Invalid image file')}
  return {bytes,type}
}
export async function inventoryMedia(request:Request,sql:NeonQueryFunction<false,false>,actor:string,env:MediaEnv):Promise<Response|object|null>{
  if(!actor)throw new InventoryError('Owner required')
  const path=new URL(request.url).pathname
  const photo=path.match(/^\/api\/inventory\/parts\/([0-9a-f-]{36})\/photo$/)
  const scan=path==='/api/inventory/scan'
  if(!photo&&!scan)return null
  if(!env.ATTACHMENTS_BUCKET || env.ATTACHMENTS_R2_ENABLED!=='true')throw new InventoryError('Image storage is unavailable')
  if(photo){
    const [part]=await sql.query('select id,photo_key from inventory_parts where id=$1',[photo[1]])
    if(!part)throw new InventoryError('Part not found')
    if(request.method==='GET'){
      if(!part.photo_key)return new Response(null,{status:404})
      const image=await env.ATTACHMENTS_BUCKET.get(part.photo_key)
      if(!image)return new Response(null,{status:404})
      return new Response(image.body,{headers:{'Content-Type':image.httpMetadata?.contentType||'image/jpeg','Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'}})
    }
    if(request.method!=='POST')throw new InventoryError('Method not allowed')
    const {bytes,type}=await imageBytes(request)
    const key=`inventory/parts/${part.id}/${crypto.randomUUID()}`
    await env.ATTACHMENTS_BUCKET.put(key,bytes,{httpMetadata:{contentType:type}})
    try{await sql.query('update inventory_parts set photo_key=$2,updated_at=now() where id=$1',[part.id,key])}catch(e){await env.ATTACHMENTS_BUCKET.delete(key);throw e}
    return {saved:true}
  }
  if(request.method!=='POST')throw new InventoryError('Method not allowed')
  if(!env.OPENAI_API_KEY)throw new InventoryError('AI scanning is unavailable. Add parts manually.')
  const {bytes,type}=await imageBytes(request)
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')
  const [existing]=await sql.query('select id,data,status from inventory_invoice_imports where content_hash=$1',[hash])
  if(existing&&['review','imported'].includes(existing.status))return existing
  const id=crypto.randomUUID(),key=`inventory/invoices/${hash}`
  const claimed=await sql.query(`insert into inventory_invoice_imports(id,content_hash,object_key,status,actor) values($1,$2,$3,'processing',$4)
    on conflict(content_hash) do update set status='processing',updated_at=now() where inventory_invoice_imports.status='failed' or (inventory_invoice_imports.status='processing' and inventory_invoice_imports.updated_at<now()-interval '3 minutes') returning id`,[id,hash,key,actor])
  if(!claimed.length)throw new InventoryError('This invoice is already being scanned. Please retry shortly.')
  const scanId=claimed[0].id
  try{
    const quota=await sql.query(`insert into receipt_ai_usage(user_id,day,calls) values($1,current_date,1) on conflict(user_id,day) do update set calls=receipt_ai_usage.calls+1 where receipt_ai_usage.calls<20 returning calls`,[actor])
    if(!quota.length)throw new InventoryError('Daily invoice scan limit reached. Manual entry remains available.')
    await env.ATTACHMENTS_BUCKET.put(key,bytes,{httpMetadata:{contentType:type}})
    const data=await recognizeReceipt(env.OPENAI_API_KEY,env.OPENAI_RECEIPT_MODEL||'gpt-4.1-mini',bytes.buffer as ArrayBuffer,type,fetch,true)
    await sql.query("update inventory_invoice_imports set status='review',data=$2::jsonb,updated_at=now() where id=$1",[scanId,JSON.stringify(data)])
    return {id:scanId,status:'review',data}
  }catch(e){await sql.query("update inventory_invoice_imports set status='failed',updated_at=now() where id=$1 and status='processing'",[scanId]);throw e}
}
