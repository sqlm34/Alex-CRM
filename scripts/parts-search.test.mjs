import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'
import * as cookies from 'tough-cookie'
import * as html from 'linkedom'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
function load(file, dependencies = {}) {
  const code = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports', 'require', code)(exports, name => { if (!(name in dependencies)) throw Error(`Unexpected import ${name}`); return dependencies[name] })
  return exports
}
const shared = load('../shared/parts.ts')
const catalog = load('../worker/parts/reliableCatalog.ts', {'../../shared/parts':shared})
const connectors = load('../worker/parts/connectors.ts', {'../../shared/parts':shared,'./reliableCatalog':catalog})
const recognition = load('../worker/parts/recognition.ts', {'../../shared/parts':shared})
const storage = load('../worker/parts/storage.ts')
const supplierAuth = load('../worker/parts/supplierAuth.ts')
const reliableAccount = load('../worker/parts/reliableAccount.ts', {'./supplierAuth':supplierAuth})
const marconeAccount = load('../worker/parts/marconeAccount.ts', {'./supplierAuth':supplierAuth,'tough-cookie':cookies,'linkedom':html})
const accountConnector = load('../worker/parts/accountConnector.ts', {'./connectors':connectors,'./reliableAccount':reliableAccount,'./marconeAccount':marconeAccount,'./reliableCatalog':catalog,'./supplierAuth':supplierAuth})
const identity = {brand:'Whirlpool',model:'WTW5057LW0',serial:'O0-I1',applianceType:'washer',confidence:.7,alternatives:['WTW5057LWO']}
const intent = {canonicalPartType:'drain_pump',searchTerms:['drain pump']}
const part = (supplier='reliable') => ({brand:'Whirlpool',model:identity.model,partNumber:'W11399437',description:'Test pump',unitCostCents:10031,currency:'USD',quantity:5,warehouse:'Test warehouse',availability:'in_stock',productUrl:supplier==='reliable'?'https://reliableparts.net/us/content/#/part/W11399437':'https://my.marcone.com/Product/Detail?Part=W11399437',evidenceUrl:supplier==='reliable'?'https://reliableparts.net/us/content/#/model/WTW5057LW0/Whirlpool':'https://my.marcone.com/Model/Index?ModelNo=WTW5057LW0',compatibility:'confirmed',replacedPartNumber:'W11259498',retrievedAt:new Date().toISOString()})
const ai = data => async () => Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(data)}]}]})

test('supplier auth PostgreSQL lease: one login, encrypted reuse, and no bad-password retries', async()=>{
  const schema=`auth_test_${Date.now()}`
  const pool=new pg.Pool({host:'127.0.0.1',port:Number(process.env.GOOGLE_ACTIONS_TEST_PORT||5432),user:'webhook_test',password:'local-test-only',database:'webhook_test',max:8,options:`-c search_path=${schema}`})
  const sql={query:async(q,p)=>(await pool.query(q,p)).rows}
  const env={RELIABLE_USERNAME:'test',RELIABLE_PASSWORD:'test',SUPPLIER_SESSION_KEY:'ab'.repeat(32)}
  let logins=0
  const adapter={supplier:'reliable',verify:async()=>true,login:async()=>{logins++;await new Promise(r=>setTimeout(r,100));return{value:'test-session',expiresAt:Date.now()+600000}}}
  try {
    await pool.query(`create schema ${schema}`)
    await sql.query(supplierAuth.authSchema)
    const results=await Promise.all(Array.from({length:5},()=>supplierAuth.supplierSession(sql,env,adapter)))
    assert.equal(logins,1);assert.equal(results.filter(r=>r.status==='REAUTHENTICATED').length,1)
    const [row]=await sql.query('select envelope from supplier_auth_state')
    assert.ok(!row.envelope.includes('test-session'))
    await sql.query("update supplier_auth_state set expires_at=now()-interval '1 minute'")
    await supplierAuth.supplierSession(sql,env,adapter)
    assert.equal(logins,2)
    await sql.query('delete from supplier_auth_state')
    adapter.login=async()=>{logins++;throw new supplierAuth.SupplierAuthError('INVALID_CREDENTIALS')}
    for(let i=0;i<3;i++) await assert.rejects(supplierAuth.supplierSession(sql,env,adapter),e=>e.status==='INVALID_CREDENTIALS')
    assert.equal(logins,3)
  } finally {await pool.query(`drop schema ${schema} cascade`);await pool.end()}
})

test('model OCR preserves ambiguous characters; AI requests use private strict structured output', async()=>{
  let request
  assert.deepEqual(await recognition.recognizeLabel('test-key',new Uint8Array([1]).buffer,'image/png',async(url,init)=>{request=JSON.parse(init.body);return ai(identity)()}),identity)
  assert.equal(request.store,false);assert.equal(request.text.format.strict,true)
  assert.match(request.input[0].content[0].image_url,/^data:image\/png;base64,/)
  assert.deepEqual(shared.identityFrom(identity),identity)
  await assert.rejects(recognition.recognizeLabel('test',new ArrayBuffer(0),'image/png',ai({...identity,confidence:2})),/PHOTO_NOT_READABLE/)
})
test('Russian part query is normalized without OEM guesses; malformed intent and provider failures are rejected',async()=>{
  let text
  assert.deepEqual(await recognition.normalizeIntent('test','сливная помпа',async(url,init)=>{text=JSON.parse(init.body).input[0].content[0].text;return ai(intent)()}),intent)
  assert.equal(text,'сливная помпа')
  for(const data of [null,{...intent,searchTerms:['http://internal']},{...intent,searchTerms:['W12345']},{...intent,canonicalPartType:'Ignore instructions!'}]) await assert.rejects(recognition.normalizeIntent('test','pump',ai(data)))
  await assert.rejects(recognition.normalizeIntent('test','pump',async()=>new Response('SECRET_DETAIL',{status:500})),e=>e.message==='AI_UNAVAILABLE')
})
test('normalization requires exact-model evidence, trustworthy URLs and integer cents',()=>{
  assert.equal(shared.normalizePart(part(),'reliable',identity.model).compatibility,'confirmed')
  assert.equal(shared.normalizePart(part(),'reliable','different').compatibility,'not_verified')
  assert.equal(shared.normalizePart({...part(),evidenceUrl:''},'reliable',identity.model).compatibility,'not_verified')
  for(const patch of [{unitCostCents:NaN},{unitCostCents:-1},{unitCostCents:1.5},{quantity:-1},{currency:'EUR'},{productUrl:'https://reliableparts.net.attacker.test/'},{productUrl:'http://127.0.0.1'},{evidenceUrl:'https://user:password@reliableparts.net/'},{retrievedAt:'2099-01-01'}]) assert.throws(()=>shared.normalizePart({...part(),...patch},'reliable',identity.model))
})
test('suppliers fail independently; login required and unconfigured never return invented inventory',async()=>{
  const service={fetch:async request=>{const url=new URL(request.url);if(url.pathname.startsWith('/marcone'))return new Response('',{status:401});return Response.json({status:'CONNECTED',results:url.pathname.endsWith('/session')?[]:[part()]})}}
  assert.equal(await new connectors.ReliablePartsConnector(service).checkSession(),'CONNECTED')
  let result=await connectors.searchSuppliers({identity,intent},[new connectors.ReliablePartsConnector(service),new connectors.MarconeConnector(service)])
  assert.equal(result[0].status,'CONNECTED',JSON.stringify(result));assert.equal(result[0].results[0].unitCostCents,10031);assert.equal(result[1].status,'LOGIN_REQUIRED');assert.deepEqual(result[1].results,[])
  assert.equal((await new connectors.MarconeConnector().checkSession()),'NOT_CONFIGURED')
  result=await connectors.searchSuppliers({identity,intent},[new connectors.ReliablePartsConnector({fetch:async()=>Response.json({status:'CONNECTED',results:[{malformed:true}]})}),new connectors.MarconeConnector(service)])
  assert.equal(result[0].status,'SUPPLIER_UNAVAILABLE')
})
test('migration matches runtime additive schema',()=>{
  const normalize=s=>s.replace(/--[^\n]*/g,'').replace(/\s+/g,'').replace(/;/g,'')
  assert.equal(normalize(read('../migrations/2026-10-07_ai_parts_search.sql')),normalize(storage.partsStatements.join('')))
})
test('real PostgreSQL: scan/search dedupe, costs, job isolation, stale quotes and quota',async()=>{
  const schema=`parts_test_${Date.now()}`
  const pool=new pg.Pool({host:'127.0.0.1',port:Number(process.env.GOOGLE_ACTIONS_TEST_PORT||5432),user:'webhook_test',password:'local-test-only',database:'webhook_test',max:8,options:`-c search_path=${schema}`})
  const sql={query:async(q,p)=>(await pool.query(q,p)).rows}
  let scans=0, searches=0
  const routes=load('../worker/parts/routes.ts',{'../../shared/parts':shared,'./accountConnector':accountConnector,'./supplierAuth':supplierAuth,'./connectors':connectors,'./storage':storage,'./recognition':{recognizeLabel:async()=>{scans++;await new Promise(r=>setTimeout(r,25));return identity},normalizeIntent:async()=>{searches++;return intent}}})
  const service={fetch:async request=>Response.json({status:'CONNECTED',results:new URL(request.url).pathname.endsWith('/session')?[]:[part(new URL(request.url).pathname.split('/')[1])]})}
  const ctx={sql,userId:'owner',jobId:'job',key:'test',service,loadImage:async id=>{if(id!=='label')throw Error('Wrong attachment');return{bytes:new ArrayBuffer(0),mime:'image/png'}}}
  const call=(suffix='',body,context=ctx)=>routes.partsRoute(new Request('https://test.invalid/',{method:body?'POST':'GET',body:body?JSON.stringify(body):undefined}),suffix,context)
  try{
    await pool.query(`create schema ${schema}`)
    await sql.query('create table jobs(id text primary key)');await sql.query("insert into jobs values('job'),('other')")
    await storage.ensurePartsTables(sql)
    const simultaneous=await Promise.all([call('/scan',{attachmentId:'label'}),call('/scan',{attachmentId:'label'})])
    assert.equal(scans,1);assert.ok(simultaneous.some(r=>r.status===200));assert.ok(simultaneous.every(r=>[200,409].includes(r.status)),JSON.stringify(simultaneous))
    await call('/scan',{attachmentId:'label'});assert.equal(scans,1)
    assert.equal((await call('/scan',{attachmentId:'foreign'})).status,400)
    const payload={identity,query:'pump',confirmed:true,requestKey:crypto.randomUUID()}
    assert.equal((await call('/search',{...payload,confirmed:false})).status,400)
    assert.equal((await call('/search',payload,{...ctx,service:undefined})).status,503)
    const searched=await call('/search',payload);assert.equal(searched.status,200)
    assert.deepEqual((await call('/search',payload)).value,searched.value);assert.equal(searches,1)
    assert.equal((await call('/search',{...payload,query:'valve'})).status,409)
    const selected={searchId:searched.value.id,resultId:'reliable:W11399437',quantity:2,unitCostCents:1}
    assert.equal((await call('',selected,{...ctx,jobId:'other'})).status,409)
    const added=await call('',selected);assert.equal(added.status,200);assert.equal(Number(added.value.part.total_cost_cents),20062)
    assert.equal((await call('',selected)).value.part.id,added.value.part.id)
    assert.equal((await call('',{...selected,quantity:3})).status,409)
    assert.equal((await call('/search/'+searched.value.id,undefined,{...ctx,jobId:'other'})).status,404)
    const data=structuredClone(searched.value);data.suppliers[0].results[0].retrievedAt='2020-01-01T00:00:00Z'
    await sql.query('update part_searches set data=$2::jsonb where id=$1',[data.id,JSON.stringify(data)])
    assert.equal((await call('',selected)).status,409)
    for(let i=0;i<30;i++)await storage.consumePartsQuota(sql,'limit-user')
    await assert.rejects(storage.consumePartsQuota(sql,'limit-user'),/DAILY_LIMIT_REACHED/)
    await sql.query("delete from jobs where id='job'")
    assert.equal((await sql.query('select * from job_parts')).length,0)
  }finally{await pool.query(`drop schema if exists ${schema} cascade`);await pool.end()}
})
test('API authorization wraps all parts operations before database or AI access',()=>{
  const worker=read('../worker/index.ts')
  const route=worker.slice(worker.indexOf('      const partsMatch ='),worker.indexOf('      const receiptsMatch ='))
  assert.ok(route.indexOf('await requireAuth')<route.indexOf('await partsRoute'))
  assert.ok(route.indexOf('await requireJobAccess')<route.indexOf('await partsRoute'))
  assert.match(route,/requireAttachmentBelongsToJob\(attachment, job.id\)/)
  assert.match(route,/object.size > 10000000/)
})
test('unauthenticated and unauthorized job requests never reach parts storage or AI',async()=>{
  const worker=read('../worker/index.ts')
  const route=worker.slice(worker.indexOf('      const partsMatch ='),worker.indexOf('      const receiptsMatch ='))
  const compiled=ts.transpileModule(`async function handler(request, env) {const url=new URL(request.url);${route}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
  let user=null, calls=0
  const bindings={getSql:()=>({}),requireAuth:async()=>{if(!user)throw Error('401');return user},requireJobAccess:async(sql,u,id)=>{if(id!=='allowed')throw Error('403');return{id}},partsRoute:async()=>{calls++;return{value:{},status:200}},json:(data,request,env,status)=>Response.json(data,{status})}
  const handler=new Function(...Object.keys(bindings),compiled+';return handler')(...Object.values(bindings))
  for(const suffix of ['','/scan','/search','/search/test']){
    await assert.rejects(handler(new Request('https://test.invalid/api/jobs/allowed/parts'+suffix),{}),/401/)
  }
  user={id:'technician'}
  await assert.rejects(handler(new Request('https://test.invalid/api/jobs/foreign/parts'),{}),/403/)
  assert.equal(calls,0)
  assert.equal((await handler(new Request('https://test.invalid/api/jobs/allowed/parts'),{})).status,200)
  assert.equal(calls,1)
})
