import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
function load(source, bindings = {}) {
  const exports = {}
  const code = ts.transpileModule(source.replace(/^import .*$/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('exports', ...Object.keys(bindings), code)(exports, ...Object.values(bindings))
  return exports
}
const receipt = load(read('../shared/receipts.ts'))
const { restoreReceipt } = load(read('../worker/receiptStorage.ts'))
const { recognizeReceipt, normalizeReceiptDate } = load(read('../worker/receiptRecognition.ts'), receipt)
const sample = () => ({ supplier: 'Synthetic Parts', date: '2026-10-07', currency: 'USD', items: [{ description: 'Pump', partNumber: 'TEST123', amountCents: 1234 }], subtotalCents: 1234, taxCents: 86, shippingCents: 0, totalCents: 1320 })

test('US invoice dates preserve month/day/year and reject impossible dates', () => {
  for (const input of ['10/06/26','10/6/2026','10-06-26','2026-10-06']) {
    assert.equal(receipt.validateReceipt({...sample(),date:normalizeReceiptDate(input)}).date,'2026-10-06')
  }
  assert.equal(normalizeReceiptDate('12/31/25'),'2025-12-31')
  assert.equal(normalizeReceiptDate('2010-06-26'),'2010-06-26')
  for (const input of ['13/01/26','02/30/26']) assert.throws(()=>receipt.validateReceipt({...sample(),date:normalizeReceiptDate(input)}))
})

test('receipt money, dates, missing amounts and status totals', () => {
  assert.equal(receipt.validateReceipt(sample(), true).totalCents, 1320)
  for (const patch of [{ totalCents: -1 }, { totalCents: 1.1 }, { totalCents: 100000001 }, { date: '2026-02-30' }, { items: [null] }]) assert.throws(() => receipt.validateReceipt({ ...sample(), ...patch }))
  for (const patch of [{ totalCents: null }, { currency: 'CAD' }, { supplier: ' ' }, { date: '' }]) assert.throws(() => receipt.validateReceipt({ ...sample(), ...patch }, true))
  assert.equal(receipt.validateReceipt({ ...sample(), taxCents: null }).taxCents, null)
  assert.equal(receipt.receiptMismatch(sample()), false)
  assert.equal(receipt.receiptMismatch({ ...sample(), totalCents: 1330 }), true)
  assert.equal(receipt.receiptCosts(['draft','confirmed','voided','failed','processing'].map(status => ({ status, data: sample() }))), 1320)
})

test('partial purchases preserve the full invoice and allocate only used items', () => {
  const rollers = { ...sample(), totalCents: 4060, items: [{ description: 'Rollers', partNumber: '', amountCents: 4060, quantity: 4, usedQuantity: 1 }] }
  assert.equal(receipt.receiptExpense(rollers), 1015)
  const saved = receipt.validateReceipt(rollers, true)
  assert.equal(saved.totalCents, 4060)
  assert.equal(saved.expenseCents, 1015)
  assert.equal(receipt.receiptCosts([{ status: 'confirmed', data: saved }]), 1015)
  const mixed = { ...sample(), totalCents: 33000, items: [{ description: 'Pumps', partNumber: '', amountCents: 20000, quantity: 2, usedQuantity: 1 }, { description: 'Motor', partNumber: '', amountCents: 10000, quantity: 1, usedQuantity: 0 }] }
  assert.equal(receipt.receiptExpense(mixed), 11000)
  assert.equal(receipt.validateReceipt({ ...mixed, expenseCents: 9750 }, true).expenseCents, 9750)
  for (const expenseCents of [-1, 0, 4061, 1.5, null]) assert.throws(() => receipt.validateReceipt({ ...rollers, expenseCents }, true))
  for (const usedQuantity of [-1, 5, 1.5]) assert.throws(() => receipt.validateReceipt({ ...rollers, items: [{ ...rollers.items[0], usedQuantity }] }, true))
  assert.throws(() => receipt.validateReceipt({ ...rollers, items: [{ ...rollers.items[0], amountCents: null }] }, true))
  assert.equal(receipt.receiptCosts([{ status: 'voided', data: saved }]), 0)
})

test('Responses image request is strict, private, validated; errors never leak provider data', async () => {
  let body
  const result = await recognizeReceipt('synthetic-not-a-real-key', 'gpt-4.1-mini', new Uint8Array([1,2]).buffer, 'image/png', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    body = JSON.parse(options.body)
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(sample()) }] }] })
  })
  assert.deepEqual(result, sample())
  const dated = await recognizeReceipt('test','test',new ArrayBuffer(0),'image/png',async()=>Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...sample(),date:'10/06/26'})}]}]}))
  assert.equal(dated.date,'2026-10-06')
  assert.equal(body.store, false)
  assert.equal(body.text.format.strict, true)
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/)
  for (const status of [401,403,429,500]) await assert.rejects(recognizeReceipt('test','test',new ArrayBuffer(0),'image/png',async () => new Response('SENSITIVE_PROVIDER_DETAIL', { status })), e => !e.message.includes('SENSITIVE'))
  for (const payload of [{status:'incomplete'}, {status:'completed',output:[{content:[{type:'refusal'}]}]}, {status:'completed',output:[{content:[{type:'output_text',text:'invalid'}]}]}]) await assert.rejects(recognizeReceipt('test','test',new ArrayBuffer(0),'image/png',async()=>Response.json(payload)))
})

test('receipt routes with real isolated PostgreSQL: authorization, deduplication, persistence, quotas and transitions', async () => {
  const schema = `receipts_test_${Date.now()}`
  const pool = new pg.Pool({ host:'127.0.0.1',port:Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 5432),user:'webhook_test',password:'local-test-only',database:'webhook_test',max:8,options:`-c search_path=${schema}` })
  const sql = { query: async (q,p) => (await pool.query(q,p)).rows }
  class ApiHttpError extends Error { constructor(message,status) { super(message);this.status=status } }
  const worker = read('../worker/index.ts')
  const route = worker.slice(worker.indexOf('      const receiptsMatch ='), worker.indexOf('      const attachmentsMatch ='))
  const compiled = ts.transpileModule(`async function handler(request, env) { const url = new URL(request.url); ${route} };`, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
  let calls = 0, fail = false, user = { id:'owner', role:'owner' }
  const dependencies = {
    getSql:()=>sql, requireAuth:async()=> { if(!user) throw new ApiHttpError('Sign in',401); return user },
    requireOwner:u=>{if(u.role!=='owner')throw new ApiHttpError('Owner only',403)},
    requireJobAccess:async(db,u,id)=>{const rows=await db.query('select * from jobs where id=$1',[id]);if(!rows[0])throw new ApiHttpError('Missing',404);return rows[0]},
    ensureJobAttachmentsTable:async()=>{}, ensureReceiptTables:async()=>{}, restoreReceipt, ApiHttpError,
    requireR2AttachmentsEnabled:()=>{}, requireAttachmentAccess:async(db,u,id)=>{const rows=await db.query('select * from job_attachments where id=$1',[id]);if(!rows[0])throw new ApiHttpError('Missing photo',404);return rows[0]},
    requireAttachmentBelongsToJob:(a,id)=>{if(a.job_id!==id)throw new ApiHttpError('Wrong job',404)},
    json:(data,req,env,status=200)=>Response.json(data,{status}), validateReceipt:receipt.validateReceipt,
    recognizeReceipt:async()=>{calls++;await new Promise(r=>setTimeout(r,30));if(fail)throw Error('Controlled AI failure');return sample()},
  }
  const handler = new Function(...Object.keys(dependencies),`${compiled};return handler`)(...Object.values(dependencies))
  const env = {OPENAI_API_KEY:'test-only',ATTACHMENTS_BUCKET:{get:async key=>({size:10,arrayBuffer:async()=>new TextEncoder().encode(key).buffer})}}
  const send = async(body,suffix='',settings=env) => {try {return await handler(new Request(`https://isolated.invalid/api/jobs/job/receipts${suffix}`,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),settings)}catch(e){if(!e.status) throw e;return Response.json({error:e.message},{status:e.status})}}
  try {
    assert.equal((await sql.query('select current_user as u'))[0].u,'webhook_test')
    await sql.query(`create schema ${schema}`)
    await sql.query('create table jobs(id text primary key); create table job_attachments(id text primary key,job_id text,object_key text,upload_status text,deleted_at timestamptz,mime_type text,size_bytes integer)')
    const migration=read('../migrations/2026-10-07_parts_receipts.sql').replaceAll('public.',`${schema}.`)
    await sql.query(migration);await sql.query(migration)
    const discardMigration=read('../migrations/2026-10-07_receipt_discard.sql').replaceAll('public.',`${schema}.`)
    await sql.query(discardMigration);await sql.query(discardMigration)
    await sql.query(read('../migrations/2026-10-11_receipt_restore.sql'))
    await sql.query("insert into jobs values('job'),('other'); insert into job_attachments values('photo','job','same-bytes','ready',null,'image/png',10),('copy','job','same-bytes','ready',null,'image/png',10),('foreign','other','foreign','ready',null,'image/png',10)")
    user=null;assert.equal((await send()).status,401)
    user={id:'tech',role:'technician'};assert.equal((await send()).status,403)
    user={id:'owner',role:'owner'}
    assert.equal((await send(null)).status,400)
    assert.equal((await send({attachmentId:'photo'},'',{})).status,503)
    assert.equal((await send({attachmentId:'foreign'})).status,404)
    const scans=await Promise.all([send({attachmentId:'photo'}),send({attachmentId:'copy'})])
    assert.ok(scans.some(r=>r.status===200));assert.ok(scans.every(r=>[200,409].includes(r.status)));assert.equal(calls,1)
    const r=(await (await send()).json()).receipts[0]
    assert.equal(r.status,'draft');assert.equal(receipt.receiptCosts([r]),0)
    assert.equal((await send({attachmentId:'photo'})).status,200);assert.equal(calls,1)
    assert.equal((await send({data:{...sample(),totalCents:-1}},`/${r.id}/confirm`)).status,400)
    const allocated = { ...sample(), items: [{ ...sample().items[0], quantity: 3, usedQuantity: 1 }] }
    assert.equal((await send({data:allocated},`/${r.id}/confirm`)).status,200)
    assert.equal((await send({data:sample()},`/${r.id}/confirm`)).status,200)
    const persisted = (await (await send()).json()).receipts
    assert.equal(receipt.receiptCosts(persisted),440)
    assert.equal(persisted[0].data.totalCents,1320)
    assert.equal(persisted[0].data.expenseCents,440)
    assert.equal((await send({},`/${r.id}/discard`)).status,409)
    await assert.rejects(sql.query("delete from jobs where id='job'"),e=>e.code==='23503')
    assert.equal((await send({},`/${r.id}/void`)).status,200)
    assert.equal((await send({},`/${r.id}/void`)).status,200)
    assert.equal(receipt.receiptCosts((await (await send()).json()).receipts),0)
    assert.equal((await send({data:sample()},`/${r.id}/confirm`)).status,409)
    assert.equal((await send({},`/${r.id}/discard`)).status,200)
    assert.equal((await send({},`/${r.id}/discard`)).status,200)
    assert.equal((await (await send()).json()).receipts.length,0)
    const retained=(await sql.query('select * from parts_receipts where id=$1',[r.id]))[0]
    assert.equal(retained.status,'voided');assert.ok(retained.confirmed_at);assert.ok(retained.deleted_at)
    assert.equal(await restoreReceipt(sql,'other',r.id,'owner'),null)
    const restoredResponse=await send({attachmentId:'copy'})
    assert.equal(restoredResponse.status,200)
    const restored=(await restoredResponse.json()).receipt
    assert.equal(restored.status,'draft');assert.equal(restored.attachment_id,'copy')
    assert.equal(restored.history.length,1);assert.equal(restored.history[0].status,'voided')
    assert.equal(restored.history[0].data.expenseCents,440)
    assert.ok(restored.history[0].confirmed_at);assert.ok(restored.history[0].deleted_at)
    assert.equal(receipt.receiptCosts([restored]),0);assert.equal(calls,1)
    const repeated=await Promise.all([send({},`/${r.id}/restore`),send({},`/${r.id}/restore`)])
    for(const response of repeated) {assert.equal(response.status,200);assert.equal((await response.json()).receipt.history.length,1)}
    assert.equal((await send({data:{...sample(),expenseCents:660}},`/${r.id}/confirm`)).status,200)
    assert.equal(receipt.receiptCosts((await (await send()).json()).receipts),660)
    assert.equal((await send({},`/${r.id}/restore`)).status,409)
    await send({},`/${r.id}/void`)
    const again=await Promise.all([send({},`/${r.id}/restore`),send({},`/${r.id}/restore`)])
    for(const response of again) assert.equal((await response.json()).receipt.history.length,2)
    assert.equal(receipt.receiptCosts((await (await send()).json()).receipts),0)
    await send({},`/${r.id}/discard`)
    await sql.query("insert into job_attachments values('failed','job','failure-test','ready',null,'image/png',10)")
    fail=true;assert.equal((await send({attachmentId:'failed'})).status,502)
    fail=false;assert.equal((await send({attachmentId:'failed'})).status,200)
    const removable=(await (await send()).json()).receipts[0]
    assert.equal((await send({},`/${removable.id}/discard`)).status,200)
    assert.equal((await send({data:sample()},`/${removable.id}/confirm`)).status,409)
    assert.equal((await send({attachmentId:'failed'})).status,200)
    assert.equal((await (await send()).json()).receipts.length,1)
    await sql.query("update receipt_ai_usage set calls=20; insert into job_attachments values('quota','job','quota-test','ready',null,'image/png',10)")
    const before=calls;assert.equal((await send({attachmentId:'quota'})).status,429);assert.equal(calls,before)
    assert.equal((await sql.query('select calls from receipt_ai_usage'))[0].calls,20)
  } finally { await pool.query(`drop schema if exists ${schema} cascade`);await pool.end() }
})
