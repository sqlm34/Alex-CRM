import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const load = async text => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(text, {compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText).toString('base64')}`)
const source = await load(read('../src/bookingSource.ts'))
const { resolveBookingAttribution: resolve, attributionLifetimeMs: ttl, normalizeBookingSource } = source
const site = 'https://aleksappliancerepair.com/booking'
const now = 1800000000000
const maps = `${site}?utm_source=google&utm_medium=organic&utm_campaign=google_maps`

test('one booking URL: explicit Maps beats Google; Google referrer alone is not Maps', () => {
  assert.equal(resolve(maps+'&gclid=test','https://google.com',null,now).source,'google_maps')
  for(const query of ['?utm_source=google','?gclid=test','?gbraid=test','?wbraid=test']) assert.equal(resolve(site+query,'',null,now).source,'google')
  for(const ref of ['https://www.google.com/search?q=repair','https://maps.google.com/','https://google.co.uk/']) assert.equal(resolve(site,ref,null,now).source,'google')
  for(const ref of ['', 'https://google.com.evil.test/', 'https://notgoogle.com/']) assert.equal(resolve(site,ref,null,now).source,'website')
  assert.equal(resolve(site+'?utm_campaign=google_maps','',null,now).source,'website')
})

test('internal/direct navigation preserves source and expiry; fresh external acquisition replaces it', () => {
  const prior = resolve(maps,'',null,now)
  assert.deepEqual(resolve(site,'',prior,now+1000),prior)
  assert.deepEqual(resolve(maps,'https://www.aleksappliancerepair.com/',prior,now+1000),prior)
  assert.equal(resolve(site,'https://google.com/',prior,now+1000).source,'google')
  assert.equal(resolve(site,'https://bing.com/',prior,now+1000).source,'website')
  assert.equal(resolve(site+'?utm_source=facebook','',prior,now+1000).source,'website')
  assert.equal(resolve(site,'',prior,now+ttl-1).source,'google_maps')
  assert.equal(resolve(site,'',prior,now+ttl).source,'website')
  for(const bad of [null, {}, {source:'google',capturedAt:now+1}, {source:'google',capturedAt:'0'}, {source:'evil',capturedAt:now}]) assert.equal(resolve(site,'',bad,now).source,'website')
})

test('blocked/corrupt storage is safe and submission does not renew source indefinitely', () => {
  const values = new Map()
  globalThis.window = {location: {href: maps, origin:'https://aleksappliancerepair.com'}}
  globalThis.document = {referrer:''}
  globalThis.localStorage = {getItem: key => values.get(key), setItem:(key,v)=>values.set(key,v)}
  source.captureBookingAttribution()
  assert.equal(source.currentBookingSource(),'google_maps')
  const saved=JSON.parse(values.get(source.attributionStorageKey))
  assert.deepEqual(Object.keys(saved).sort(),['capturedAt','source'])
  values.set(source.attributionStorageKey,JSON.stringify({...saved,capturedAt:Date.now()-ttl-1}))
  assert.equal(source.currentBookingSource(),'website')
  source.captureBookingAttribution('reload')
  assert.equal(source.currentBookingSource(),'website')
  globalThis.localStorage = {getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')}}
  source.captureBookingAttribution()
  assert.equal(source.currentBookingSource(),'google_maps')
  delete globalThis.window; delete globalThis.document; delete globalThis.localStorage
})

test('real public booking normalizer and API wrapper pass only the validated source into a job', async () => {
  const compile=(text,name,deps)=>{
    const ast=ts.createSourceFile('input.ts',text,ts.ScriptTarget.Latest,true)
    const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)
    const js=ts.transpileModule(fn.getText(ast).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    return new Function(...Object.keys(deps),js+`;return ${name}`)(...Object.values(deps))
  }
  const normalize=compile(read('../worker/index.ts'),'normalizePublicBooking',{
    normalizeBookingSource,normalizeSmsPhone:x=>x,normalizePhone:x=>x,normalizeEmail:x=>x,
    bookingServices:()=>['Washer repair'],bookingWindows:()=>['9:00 AM - 11:00 AM'],
    calculateBookingRisk:async()=>({score:0,decision:'ALLOW',reasons:[]}),highestRiskDecision:()=> 'ALLOW',
    normalizeRiskReasons:()=>[],recordBookingRiskEvent:async()=>{},createJobId:()=> 'J-TEST',
    normalizeNullableJobText:x=>x,ApiHttpError:Error,
  })
  for(const booking_source of ['google_maps','google','website',undefined,'invalid']) {
    const payload={customer:'Test',phone:'5555555555',email:'test@example.test',address:'Test address',appliance:'Washer repair',issue:'Test only',model_photo_names:['test.jpg'],service_date:'2026-09-10',service_window:'9:00 AM - 11:00 AM',booking_source}
    const job=await normalize({query:async()=>[]},payload,{risk_score:0,risk_decision:'ALLOW'},[])
    assert.equal(job.booking_source,normalizeBookingSource(booking_source)||'website')
    let body
    const create=compile(read('../src/api.ts'),'createPublicBooking',{
      apiUrl:'https://isolated.example.test',filesToBookingPhotoAttachments:async()=>[],normalizeJobRow:x=>x,
      fetch:async(url,request)=>{body=JSON.parse(request.body);return {ok:true,json:async()=>job}},
    })
    await create({...payload,booking_source:job.booking_source})
    assert.equal(body.booking_source,job.booking_source)
  }
})

test('Worker validates enum, saves public source, rejects client tagging of manual jobs, and list is lightweight', async () => {
  const worker=read('../worker/index.ts')
  assert.match(worker,/booking_source: normalizeBookingSource\(payload.booking_source\) \|\| 'website'/)
  assert.match(worker,/insertJob\(sql, \{ \.\.\.job, booking_source: null \}, user.id\)/)
  const ast=ts.createSourceFile('worker.ts',worker,ts.ScriptTarget.Latest,true)
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='insertJobWithId')
  const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const insert=new Function('normalizeBookingSource','normalizeNullableJobText','normalizeFinanceItems','normalizePayments','normalizeStoredModelPhotoAttachments',js+';return insertJobWithId')(normalizeBookingSource,x=>x,x=>x,x=>x,x=>x)
  for(const value of ['google_maps','google','website',null,'evil',{},'Google']) {
    let params
    await insert({query:async(sql,p)=>{ assert.match(sql,/booking_source/);assert.match(sql,/\$21::text/);params=p;return [] }},{booking_source:value},null)
    assert.equal(params[20],normalizeBookingSource(value))
  }
  const list=worker.slice(worker.indexOf('const listFields'),worker.indexOf('const rows',worker.indexOf('const listFields')))
  assert.match(list,/jobs.booking_source/)
  assert.doesNotMatch(list,/jobs.finance_items|jobs.payments/)
  const migration=read('../migrations/2026-09-09_add_booking_source.sql')
  assert.match(migration,/add column if not exists booking_source text/)
  assert.doesNotMatch(migration,/\b(drop|truncate|delete|update|insert)\b/i)
})

test('badge source survives lightweight polling; old/manual jobs have no badge', async () => {
  const {mergeJobListRows}=await load(read('../src/jobMerge.ts'))
  for(const value of ['google_maps','google','website',null]) {
    const job={id:'test',bookingSource:value,financeItems:[],payments:[],detailsLoaded:true}
    const [merged]=mergeJobListRows([job],[{id:'test',booking_source:value}],row=>({...job,bookingSource:normalizeBookingSource(row.booking_source),detailsLoaded:false}),new Set())
    assert.equal(merged.bookingSource,value)
  }
  const app=read('../src/App.tsx')
  assert.match(app,/booking_source: currentBookingSource\(\)/)
  assert.match(app,/bookingSource: normalizeBookingSource\(row.booking_source\)/)
  assert.match(app,/activeJob.bookingSource && <span className="booking-source-badge"/)
})
