import type { NeonQueryFunction } from '@neondatabase/serverless'
import { inventoryNumber } from '../shared/inventory'

export class InventoryError extends Error { status = 400 }
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InventoryError('Invalid text field')
  return value.trim()
}
async function body(request: Request) {
  const raw = await request.text()
  if (raw.length > 60000) throw new InventoryError('Request too large')
  let p: Record<string, unknown>
  try { p = JSON.parse(raw) } catch { throw new InventoryError('Invalid request') }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new InventoryError('Invalid request')
  return p
}
function validatePurchase(p:Record<string,unknown>) {
  text(p.supplier,200,true);text(p.invoiceNumber||'',100)
  if(!Number.isSafeInteger(p.quantity)||Number(p.quantity)<1||Number(p.quantity)>100000)throw new InventoryError('Invalid quantity')
  if(!Number.isSafeInteger(p.totalCents)||Number(p.totalCents)<0||Number(p.totalCents)>100000000)throw new InventoryError('Invalid total')
  if(typeof p.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!Number.isFinite(Date.parse(p.date))||new Date(p.date).toISOString().slice(0,10)!==p.date)throw new InventoryError('Invalid purchase date')
  if(p.costBreakdown){
    const b=p.costBreakdown as Record<string,unknown>
    if(!Number.isSafeInteger(b.enteredCents)||Number(b.enteredCents)<0||!Number.isSafeInteger(b.additionalCents)||Number(b.additionalCents)<0||typeof b.alreadyIncluded!=='boolean'||Number(b.enteredCents)+(b.alreadyIncluded?0:Number(b.additionalCents))!==p.totalCents)throw new InventoryError('Purchase charges do not match the total')
  }
}
export async function inventoryRoute(request: Request, sql: NeonQueryFunction<false, false>, actor: string) {
  if (!actor) throw new InventoryError('Owner required')
  const url = new URL(request.url), path = url.pathname.replace(/^\/api\/inventory/, '')
  const ready = await sql.query("select to_regclass('inventory_parts') as ready")
  if (!ready[0]?.ready) { const error = new InventoryError('Inventory setup pending'); error.status=503; throw error }
  if (request.method === 'GET' && path === '/parts') {
    const search = (url.searchParams.get('search') || '').trim().slice(0,100)
    const rows = await sql.query(`select p.*,coalesce(b.quantity,0) as quantity,coalesce(b.value_cents,0) as value_cents,
      coalesce(b.suppliers,'') as suppliers,b.last_purchase,b.purchase_dates from inventory_parts p left join lateral (
      select sum(remaining) as quantity,sum(remaining_cents) as value_cents,string_agg(distinct supplier,', ') as suppliers,max(purchase_date) as last_purchase,array_agg(distinct to_char(purchase_date,'YYYY-MM-DD')) as purchase_dates
      from inventory_batches where part_id=p.id) b on true
      where $1='' or position(lower($1) in lower(p.name||' '||p.part_number||' '||p.brand||' '||coalesce(b.suppliers,'')))>0
      or ($2<>'' and position($2 in p.number_key)>0) order by p.name,p.id`,[search,inventoryNumber(search)])
    return { parts: rows }
  }
  if (request.method === 'GET' && path === '/usage') {
    const job = text(url.searchParams.get('jobId'),150,true)
    return { usage: await sql.query(`select u.*,p.name,p.part_number from inventory_job_usage u join inventory_parts p on p.id=u.part_id where u.job_id=$1 order by u.created_at desc`,[job]) }
  }
  const detail = path.match(/^\/parts\/([^/]+)$/)
  const expense = path.match(/^\/usage\/([^/]+)\/expense$/)
  if(expense && uuid(expense[1]) && request.method==='PUT') {
    const p=await body(request)
    if(p.confirmed!==true || !Number.isSafeInteger(p.expenseCents) || Number(p.expenseCents)<0 || Number(p.expenseCents)>100000000)throw new InventoryError('Invalid job expense')
    const rows=await sql.query(`with changed as (
      update inventory_job_usage set expense_cents=$2 where id=$1 and returned_at is null returning id,expense_cents
    ) update parts_receipts r set data=jsonb_set(r.data,'{expenseCents}',to_jsonb(c.expense_cents)),updated_at=now(),
      history=coalesce(r.history,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('status','cost_adjusted','data',r.data,'restored_at',now(),'actor',$3::text))
      from changed c where r.inventory_usage_id=c.id and r.status='confirmed' returning r.id`,[expense[1],p.expenseCents,actor])
    if(!rows.length)throw new InventoryError('Usage unavailable or already returned')
    return {saved:true}
  }
  const importMatch = path.match(/^\/imports\/([^/]+)\/confirm$/)
  if (importMatch && uuid(importMatch[1]) && request.method==='POST') {
    const p=await body(request)
    if(p.confirmed!==true || !Array.isArray(p.lines) || !p.lines.length || p.lines.length>100)throw new InventoryError('Review and confirm every invoice line')
    const lines=p.lines.map((line:Record<string,unknown>)=>{
      if(!line || typeof line!=='object' || !Number.isSafeInteger(line.quantity) || Number(line.quantity)<1 || Number(line.quantity)>100000)throw new InventoryError('Enter the physical unit quantity for every line')
      if(!Number.isSafeInteger(line.totalCents) || Number(line.totalCents)<0 || Number(line.totalCents)>100000000)throw new InventoryError('Invalid allocated line total')
      const partNumber=text(line.partNumber,100,true)
      if(!inventoryNumber(partNumber))throw new InventoryError('Part number required')
      const date=text(line.date,10,true)
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new InventoryError('Invalid purchase date')
      return {partId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:text(line.name,200,true),partNumber,brand:text(line.brand,100),quantity:line.quantity,totalCents:line.totalCents,supplier:text(line.supplier,200,true),invoiceNumber:text(line.invoiceNumber||'',100),date}
    })
    if(!Number.isSafeInteger(p.totalCents)||lines.reduce((sum,line)=>sum+Number(line.totalCents),0)!==p.totalCents)throw new InventoryError('Line totals must match the invoice total including tax and shipping')
    try { return (await sql.query('select inventory_import_invoice($1::uuid,$2::jsonb,$3,$4::boolean) as result',[importMatch[1],JSON.stringify(lines),actor,false]))[0].result }
    catch(e) { if ((e as {code?:string}).code === 'P0001') throw new InventoryError((e as Error).message); throw e }
  }
  if (detail && uuid(detail[1]) && request.method === 'GET') {
    return { batches: await sql.query('select * from inventory_batches where part_id=$1 order by purchase_date,created_at,id',[detail[1]]),
      movements: await sql.query('select * from inventory_movements where part_id=$1 order by created_at desc,id desc limit 300',[detail[1]]) }
  }
  if ((path === '/parts' && request.method === 'POST') || (detail && request.method === 'PUT')) {
    const p = await body(request), id = detail?.[1] || p.id
    if (!uuid(id)) throw new InventoryError('Invalid part ID')
    const number = text(p.part_number,100,true)
    if (!inventoryNumber(number)) throw new InventoryError('Invalid part number')
    if (!Number.isSafeInteger(p.low_stock) || Number(p.low_stock)<0 || Number(p.low_stock)>100000) throw new InventoryError('Invalid low stock threshold')
    const values = [id,text(p.name,200,true),number,text(p.brand,100),text(p.location,200),text(p.notes,2000),text(p.models,1000),p.low_stock]
    if(p.purchase){if(!uuid(p.requestId))throw new InventoryError('Invalid request ID');validatePurchase(p.purchase as Record<string,unknown>)}
    try {
      if(!detail)return (await sql.query('select inventory_create_part($1::jsonb,$2) as result',[JSON.stringify({...p,id}),actor]))[0].result
      const rows = await sql.query(`update inventory_parts set name=$2,part_number=$3,brand=$4,location=$5,notes=$6,models=$7,low_stock=$8,updated_at=now() where id=$1 returning id`,values)
      if(!rows.length)throw new InventoryError('Part not found')
      return { id: rows[0]?.id || id }
    } catch (e) { if ((e as {code?:string}).code === '23505') throw new InventoryError('This part number and brand already exist. Open that part and add stock.'); if ((e as {code?:string}).code === 'P0001') throw new InventoryError((e as Error).message); throw e }
  }
  if (path === '/movements' && request.method === 'POST') {
    const p = await body(request)
    if (p.confirmed !== true || !uuid(p.requestId) || !uuid(p.partId)) throw new InventoryError('Confirm this stock movement')
    if (!Number.isSafeInteger(p.quantity) || Number(p.quantity)<1 || Number(p.quantity)>100000) throw new InventoryError('Invalid quantity')
    if (!['stock_in','stock_out','return','adjustment','damaged'].includes(String(p.action))) throw new InventoryError('Invalid movement')
    if (p.action === 'stock_in') {
      validatePurchase(p)
    }
    if (p.action==='stock_out') text(p.jobId,150,true)
    if (p.action==='return' && !uuid(p.usageId)) throw new InventoryError('Invalid usage')
    try { return (await sql.query('select inventory_move($1::jsonb,$2) as result',[JSON.stringify(p),actor]))[0].result }
    catch(e) { if ((e as {code?:string}).code === 'P0001') throw new InventoryError((e as Error).message); throw e }
  }
  const error = new InventoryError('Not found'); error.status=404; throw error
}
