import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import ts from 'typescript'
import {createRequire} from 'node:module'
import {resolve,dirname} from 'node:path'
const cache=new Map()
function load(file){
  const path=resolve(file);if(cache.has(path))return cache.get(path)
  const module={exports:{}};cache.set(path,module.exports);const require=createRequire(path)
  new Function('require','exports','module',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>name.startsWith('.')?load(resolve(dirname(path),name+'.ts')):require(name),module.exports,module)
  return module.exports
}

test('inventory recognition keeps invoice, brand, unit price and US date without changing ordinary receipt schema',async()=>{
  const {recognizeReceipt}=load('worker/receiptRecognition.ts')
  const data={supplier:'Amazon',date:'10/06/26',currency:'USD',invoiceNumber:'INV-1',items:[{description:'Belt',partNumber:'6602',brand:'Samsung',quantity:2,unitPriceCents:1000,amountCents:2000}],subtotalCents:2000,taxCents:138,shippingCents:0,totalCents:2138}
  const result=await recognizeReceipt('test','test',new ArrayBuffer(0),'image/png',async(_url,options)=>{
    const request=JSON.parse(options.body)
    assert.equal(request.store,false)
    assert.ok(request.text.format.schema.required.includes('invoiceNumber'))
    return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]})
  },true)
  assert.equal(result.date,'2026-10-06');assert.equal(result.invoiceNumber,'INV-1')
  assert.equal(result.items[0].brand,'Samsung');assert.equal(result.items[0].unitPriceCents,1000)
})

test('inventory media rejects invalid images, requires owner and supports manual use without AI',async()=>{
  const {inventoryMedia}=load('worker/inventoryMedia.ts')
  const id=crypto.randomUUID(),objects=new Map()
  let photoKey=null
  const sql={query:async(q,args)=>{if(q.startsWith('select id,photo_key'))return [{id,photo_key:photoKey}];if(q.startsWith('update inventory_parts')){photoKey=args[1];return []}throw Error('Unexpected SQL')}}
  const bucket={put:async(key,bytes,options)=>objects.set(key,{body:bytes,httpMetadata:options.httpMetadata}),get:async key=>objects.get(key),delete:async key=>objects.delete(key)}
  const env={ATTACHMENTS_BUCKET:bucket,ATTACHMENTS_R2_ENABLED:'true'}
  const photo=(bytes,type='image/png')=>new Request(`https://test/api/inventory/parts/${id}/photo`,{method:'POST',headers:{'Content-Type':type},body:bytes})
  await assert.rejects(inventoryMedia(photo('invalid'),sql,'',env),/Owner/)
  await assert.rejects(inventoryMedia(photo('invalid'),sql,'owner',env),/Invalid image/)
  await assert.rejects(inventoryMedia(photo('invalid','text/html'),sql,'owner',env),/JPG/)
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])
  assert.deepEqual(await inventoryMedia(photo(bytes),sql,'owner',env),{saved:true})
  const image=await inventoryMedia(new Request(`https://test/api/inventory/parts/${id}/photo`),sql,'owner',env)
  assert.equal(image.headers.get('Content-Type'),'image/png')
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()),bytes)
  await assert.rejects(inventoryMedia(new Request('https://test/api/inventory/scan',{method:'POST'}),sql,'owner',env),/Add parts manually/)
  assert.equal(objects.size,1)
})

test('customer names retain single names and identity never merges conflicting family records',()=>{
  const {customerIdentity,customerName}=load('shared/customerIdentity.ts')
  assert.deepEqual(customerName('John'),{firstName:'John',lastName:''})
  assert.deepEqual(customerName('John Smith'),{firstName:'John',lastName:'Smith'})
  const first={customer:'John Smith',phone:'(317) 555-0142',address:'1 Civic Square, Carmel, IN 46032'}
  assert.equal(customerIdentity(first),customerIdentity({...first,phone:'+13175550142',customer:' JOHN  SMITH '}))
  assert.notEqual(customerIdentity(first),customerIdentity({...first,customer:'Jane Smith'}))
  assert.notEqual(customerIdentity(first),customerIdentity({...first,address:'2 Civic Square, Carmel, IN 46032'}))
})

test('invoice scan saves review only and repeated upload reuses recognition without adding stock',async()=>{
  const db=new PGlite(),originalFetch=globalThis.fetch
  try{
    await db.exec('create table jobs(id text primary key,status text)')
    for(const statement of load('worker/receiptStorage.ts').receiptSchemaStatements)await db.exec(statement)
    await db.exec(readFileSync('migrations/2026-10-22_parts_inventory.sql','utf8'))
    const sql={query:async(q,args)=>(await db.query(q,args)).rows}
    let calls=0
    const data={supplier:'Amazon',date:'10/06/26',currency:'USD',invoiceNumber:'INV-1',items:[{description:'Belt',partNumber:'6602',brand:'Samsung',quantity:2,unitPriceCents:1000,amountCents:2000}],subtotalCents:2000,taxCents:138,shippingCents:0,totalCents:2138}
    globalThis.fetch=async()=>{calls++;return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]})}
    const env={ATTACHMENTS_BUCKET:{put:async()=>{}},ATTACHMENTS_R2_ENABLED:'true',OPENAI_API_KEY:'synthetic'}
    const request=()=>new Request('https://test/api/inventory/scan',{method:'POST',headers:{'Content-Type':'image/png'},body:Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])})
    const {inventoryMedia}=load('worker/inventoryMedia.ts')
    const first=await inventoryMedia(request(),sql,'owner',env)
    const second=await inventoryMedia(request(),sql,'owner',env)
    assert.equal(first.status,'review');assert.equal(first.id,second.id);assert.equal(calls,1)
    assert.equal((await db.query('select count(*)::int as count from inventory_parts')).rows[0].count,0)
    assert.equal((await db.query('select calls from receipt_ai_usage')).rows[0].calls,1)
  }finally{globalThis.fetch=originalFetch;await db.close()}
})

test('inventory API imports once, posts expenses into existing statistics and adjusts cost without changing stock',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create table jobs(id text primary key,customer text,service_date date,status text,invoice numeric,finance_items jsonb default '[]',payments jsonb default '[]',booking_source text,booking_source_detail text);
      insert into jobs(id,customer,service_date,status,invoice) values('job1','John Smith','2026-10-22','scheduled',150),('job2','John','2026-10-22','scheduled',89)`)
    for(const statement of load('worker/receiptStorage.ts').receiptSchemaStatements)await db.exec(statement)
    const migration=readFileSync('migrations/2026-10-22_parts_inventory.sql','utf8')
    await db.exec(migration)
    await db.exec(readFileSync('migrations/2026-10-22_customer_name_parts.sql','utf8'))
    assert.deepEqual((await db.query("select customer_first_name,customer_last_name from jobs order by id")).rows,[{customer_first_name:'John',customer_last_name:'Smith'},{customer_first_name:'John',customer_last_name:''}])
    await db.transaction(async tx=>{for(const statement of load('worker/statisticsStorage.ts').statisticsSchemaStatements)await tx.exec(statement)})
    const sql={query:async(text,args)=>(await db.query(text,args)).rows}
    const {inventoryRoute}=load('worker/inventory.ts')
    const request=(path,payload,method='POST')=>new Request('https://test/api/inventory'+path,{method:payload?method:'GET',...(payload?{body:JSON.stringify(payload)}:{})})
    await assert.rejects(inventoryRoute(request('/parts'),sql,''),/Owner/)
    const id=crypto.randomUUID()
    const p={id,name:'Roller',part_number:'DC 123',brand:'Samsung',location:'Van',notes:'',models:'',low_stock:1}
    await inventoryRoute(request('/parts',p),sql,'owner')
    await inventoryRoute(request('/parts',p),sql,'owner')
    const move=payload=>inventoryRoute(request('/movements',{partId:id,confirmed:true,requestId:crypto.randomUUID(),...payload}),sql,'owner')
    await move({action:'stock_in',quantity:4,totalCents:4060,date:'2026-10-22',supplier:'Amazon'})
    const result=await move({action:'stock_out',quantity:1,jobId:'job1'})
    let report=(await db.query('select report from crm_monthly_statistics')).rows[0].report
    assert.equal(report.parts,1015);assert.equal(report.net,22885)
    await inventoryRoute(request(`/usage/${result.id}/expense`,{confirmed:true,expenseCents:500},'PUT'),sql,'owner')
    assert.equal((await db.query('select purchase_cents::int as cents from inventory_job_usage')).rows[0].cents,1015)
    assert.equal((await inventoryRoute(request('/parts'),sql,'owner')).parts[0].quantity,3)
    report=(await db.query('select report from crm_monthly_statistics')).rows[0].report
    assert.equal(report.parts,500)
    await move({action:'return',quantity:1,usageId:result.id})
    assert.equal((await db.query('select report from crm_monthly_statistics')).rows[0].report.parts,0)
    const importId=crypto.randomUUID()
    await db.query("insert into inventory_invoice_imports(id,content_hash,object_key,status,actor) values($1,'hash','image','review','owner')",[importId])
    const line={name:'Pump',partNumber:'WP123',brand:'Whirlpool',quantity:2,totalCents:6000,supplier:'Reliable',date:'2026-10-22'}
    const invoice={confirmed:true,totalCents:6000,lines:[line]}
    await assert.rejects(inventoryRoute(request(`/imports/${importId}/confirm`,{...invoice,totalCents:6001}),sql,'owner'),/totals/)
    await inventoryRoute(request(`/imports/${importId}/confirm`,invoice),sql,'owner')
    const replay=await inventoryRoute(request(`/imports/${importId}/confirm`,invoice),sql,'owner')
    assert.equal(replay.replay,true)
    assert.equal((await inventoryRoute(request('/parts?search=wp-123'),sql,'owner')).parts[0].quantity,2)
    assert.equal((await db.query('select count(*)::int as count from inventory_batches')).rows[0].count,2)
    const secondImportId=crypto.randomUUID()
    await db.query("insert into inventory_invoice_imports(id,content_hash,object_key,status,actor) values($1,'different-photo','image2','review','owner')",[secondImportId])
    const duplicate=await inventoryRoute(request(`/imports/${secondImportId}/confirm`,invoice),sql,'owner')
    assert.equal(duplicate.duplicate,true);assert.equal(duplicate.existingImportId,importId)
    assert.equal((await db.query('select count(*)::int as count from inventory_batches')).rows[0].count,2)
    await inventoryRoute(request(`/imports/${secondImportId}/confirm`,{...invoice,allowDuplicate:true}),sql,'owner')
    assert.equal((await inventoryRoute(request('/parts?search=wp-123'),sql,'owner')).parts[0].quantity,4)
    const initial={...p,id:crypto.randomUUID(),part_number:'BELT-1',requestId:crypto.randomUUID(),purchase:{quantity:2,supplier:'Amazon',date:'2026-10-22',totalCents:2138,costBreakdown:{enteredCents:2000,additionalCents:138,alreadyIncluded:false}}}
    await inventoryRoute(request('/parts',initial),sql,'owner')
    await inventoryRoute(request('/parts',initial),sql,'owner')
    const belt=(await inventoryRoute(request('/parts?search=BELT-1'),sql,'owner')).parts[0]
    assert.equal(belt.quantity,2);assert.equal(Number(belt.value_cents),2138)
    await assert.rejects(inventoryRoute(request('/parts',{...initial,id:crypto.randomUUID(),part_number:'BAD',purchase:{...initial.purchase,totalCents:2000}}),sql,'owner'),/charges/)
    assert.equal((await inventoryRoute(request('/parts?search=BAD'),sql,'owner')).parts.length,0)
    assert.equal((await db.query("select count(*)::int as count from pg_constraint where conrelid='parts_receipts'::regclass and conname='parts_receipts_inventory_usage_id_fkey'")).rows[0].count,1)
  }finally{await db.close()}
})

test('inventory migration, FIFO, partial usage, cents, replay, returns and stock guards', async () => {
  const db = new PGlite()
  try {
    await db.exec("create table jobs(id text primary key,status text); insert into jobs values('job1','scheduled'),('job2','scheduled')")
    await db.exec(`create table parts_receipts(id text primary key,job_id text,attachment_id text,content_hash text,status text,data jsonb,created_by text,confirmed_by text,confirmed_at timestamptz,voided_by text,updated_at timestamptz)`)
    const migration = readFileSync('migrations/2026-10-22_parts_inventory.sql','utf8')
    await db.exec(migration); await db.exec(migration)
    const partId = crypto.randomUUID()
    await db.query('insert into inventory_parts(id,name,part_number,brand) values($1,$2,$3,$4)',[partId,'Roller','DC-123','Samsung'])
    await assert.rejects(db.query('insert into inventory_parts(id,name,part_number,brand) values($1,$2,$3,$4)',[crypto.randomUUID(),'Duplicate','DC 123','samsung']), /unique/)
    const move = async p => (await db.query('select inventory_move($1::jsonb,$2) as result',[JSON.stringify(p),'owner'])).rows[0].result
    const command = (action,quantity,extra={}) => ({requestId:crypto.randomUUID(),partId,action,quantity,...extra})
    const purchase = command('stock_in',4,{supplier:'Amazon',date:'2026-10-01',totalCents:4060})
    await move(purchase); await move(purchase)
    await move(command('stock_in',1,{supplier:'Reliable',date:'2026-10-02',totalCents:1001}))
    const use = command('stock_out',2,{jobId:'job1'})
    assert.equal((await move(use)).costCents,2030)
    assert.equal((await db.query("select (data->>'expenseCents')::int as cost from parts_receipts where id=$1",[use.requestId])).rows[0].cost,2030)
    assert.equal((await move(use)).costCents,2030)
    await assert.rejects(move({...use,quantity:1}), /Request ID/)
    await assert.rejects(move(command('stock_out',4,{jobId:'job2'})), /Not enough stock/)
    assert.equal((await db.query('select sum(remaining)::int as qty from inventory_batches')).rows[0].qty,3)
    assert.equal((await move(command('stock_out',3,{jobId:'job2'}))).costCents,3031)
    await assert.rejects(move(command('stock_out',1,{jobId:'job1'})), /Not enough stock/)
    const returned = command('return',2,{usageId:use.requestId})
    await move(returned); await move(returned)
    assert.equal((await db.query('select status from parts_receipts where id=$1',[use.requestId])).rows[0].status,'voided')
    await assert.rejects(move(command('return',2,{usageId:use.requestId})), /already returned/)
    assert.equal((await db.query('select sum(remaining_cents)::int as cents from inventory_batches')).rows[0].cents,2030)
    await assert.rejects(move(command('damaged',1)), /Reason required/)
    await move(command('damaged',1,{reason:'Broken'}))
    await move(command('stock_out',1,{jobId:'job1'}))
    await assert.rejects(move(command('stock_out',1,{jobId:'job2'})), /Not enough stock/)
    await move(command('stock_in',3,{supplier:'Store',date:'2026-10-03',totalCents:100}))
    const costs=[]
    for(let i=0;i<3;i++) costs.push((await move(command('stock_out',1,{jobId:'job1'}))).costCents)
    assert.deepEqual(costs,[33,33,34])
    const balance=(await db.query('select sum(remaining)::int as qty,sum(remaining_cents)::int as cents from inventory_batches')).rows[0]
    assert.deepEqual(balance,{qty:0,cents:0})
    assert.equal((await db.query("select count(*)::int as count from inventory_job_usage where returned_at is not null")).rows[0].count,1)
  } finally { await db.close() }
})
