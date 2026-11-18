import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import ts from 'typescript'

const exports = {}
const support = {}
new Function('exports',ts.transpileModule(readFileSync(new URL('../shared/receptionist-support.ts',import.meta.url),'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(support)
new Function('exports','require',ts.transpileModule(readFileSync(new URL('../worker/receptionist/callbacks.ts',import.meta.url),'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports, () => ({ ReceptionistError: Error }))

test('categories are explicit, never inferred from summaries or human requests', () => {
  assert.equal(exports.supportCategory(undefined),'customer_callback')
  for (const category of exports.supportCategories) assert.equal(exports.supportCategory(category),category)
  for (const value of ['human_requested','call me back',null,{}]) assert.throws(() => exports.supportCategory(value))
  assert.equal(exports.callbackIssueKey(' Jane  Doe ','+13175550142','missed_visit'),exports.callbackIssueKey('jane doe','+13175550142','missed_visit'))
  assert.notEqual(exports.callbackIssueKey('Jane','+13175550142','missed_visit'),exports.callbackIssueKey('Jane','+13175550142','estimate_copy'))
})

test('solicitations are excluded from customer callbacks but visible separately and in Calls', () => {
  const vendor = { support_category:'business_solicitation',callback_status:'pending' }
  assert.equal(support.supportQueueMatch(vendor,'Callbacks'),false)
  assert.equal(support.supportQueueMatch(vendor,'Solicitations'),true)
  assert.equal(support.supportQueueMatch(vendor,'Calls'),true)
  for (const category of ['estimate_copy','missed_visit','customer_callback',null]) {
    const customer = { ...vendor,support_category:category }
    assert.equal(support.supportQueueMatch(customer,'Callbacks'),true)
    assert.equal(support.supportQueueMatch(customer,'Solicitations'),false)
  }
  assert.equal(support.supportQueueMatch({...vendor,callback_status:'resolved'},'Solicitations'),false)
})

test('migration, repeated calls, webhook review upgrade, resolution and consent provenance', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table jobs(id text primary key);`)
    for (const file of ['2026-10-16_ai_receptionist.sql','2026-10-16_receptionist_callback_push.sql','2026-10-17_receptionist_abandoned_calls.sql','2026-11-18_receptionist_support_callbacks.sql','2026-11-18_receptionist_support_callbacks.sql']) {
      await db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'))
    }
    const sql = { query: async (query,params) => (await db.query(query,params)).rows }
    const add = async id => db.query("insert into receptionist_calls(id,provider,provider_call_id,caller_phone) values($1,'retell',$1,'+13175550142')",[id])
    await add('a'); await add('b'); await add('c'); await add('d'); await add('e')
    await db.query("insert into receptionist_callbacks(call_id,customer,phone,reason,kind) values('a','Caller','+13175550142','Unknown','abandoned')")
    const input = { callId:'a', customer:'Jane',phone:'+13175550142',reason:'Missed appointment',category:'missed_visit' }
    const first = await exports.recordConfirmedCallback(sql,input)
    assert.equal(first.kind,'requested')
    assert.equal(first.consent_source,'confirmed_callback_tool')
    assert.equal(first.consent_call_id,'a')
    const originalReview = (await db.query("select review_snapshot from receptionist_callback_context where source_call_id='a'")).rows[0].review_snapshot
    assert.equal(originalReview.kind,'abandoned')
    assert.equal(originalReview.reason,'Unknown')
    assert.equal(new Date(originalReview.created_at).getTime(),new Date(first.created_at).getTime())
    assert.equal((await exports.recordConfirmedCallback(sql,input)).call_id,'a')
    const repeated = await Promise.all([exports.recordConfirmedCallback(sql,{...input,callId:'b',reason:'Calling again'}),exports.recordConfirmedCallback(sql,{...input,callId:'c'})])
    assert.ok(repeated.every(row => row.call_id==='a'))
    assert.equal((await db.query('select * from receptionist_callbacks')).rows.length,1)
    assert.equal((await db.query('select * from receptionist_callback_context')).rows.length,3)
    assert.equal((await db.query("select reason from receptionist_callback_context where source_call_id='b'")).rows[0].reason,'Calling again')
    await db.query("insert into receptionist_callbacks(call_id,customer,phone,reason,kind) values('e','Caller','+13175550142','Original review','abandoned')")
    const merged = await exports.recordConfirmedCallback(sql,{...input,callId:'e',reason:'Latest missed visit details'})
    assert.equal(merged.call_id,'a')
    assert.equal(merged.reason,'Latest missed visit details')
    const retained = (await db.query("select * from receptionist_callbacks where call_id='e'")).rows[0]
    assert.equal(retained.kind,'abandoned')
    assert.equal(retained.reason,'Original review')
    assert.equal(retained.status,'resolved')
    assert.equal(retained.merged_into_call_id,'a')
    assert.equal((await exports.recordConfirmedCallback(sql,input)).reason,'Latest missed visit details')
    await assert.rejects(exports.recordConfirmedCallback(sql,{...input,reason:'Changed details'}))
    await db.query("update receptionist_callbacks set status='resolved' where call_id='a'")
    assert.equal((await exports.recordConfirmedCallback(sql,{...input,callId:'d'})).call_id,'d')
    assert.equal((await db.query("select outcome from receptionist_calls where id='c'")).rows[0].outcome,'callback_requested')
  } finally { await db.close() }
})
