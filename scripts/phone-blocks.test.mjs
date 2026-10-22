import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const cache = new Map()
function load(file) {
  const path = resolve(file)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }; cache.set(path, module.exports)
  const require = createRequire(path)
  new Function('require','exports','module',ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name => name.startsWith('.') ? load(resolve(dirname(path),name+'.ts')) : require(name),module.exports,module)
  return module.exports
}
const { blockedPhone, phoneBlockManagement, inboundPhoneBlock } = load('worker/receptionist/phone-blocks.ts')
test('normalizes US numbers and preserves international E.164', () => {
  assert.equal(blockedPhone('(317) 555-0123'), '+13175550123')
  assert.equal(blockedPhone('+44 20 7946 0958'), '+442079460958')
  for (const invalid of ['', 'anonymous', null, '123', '+0 12345678']) assert.throws(() => blockedPhone(invalid))
})
test('owner mutations are atomic, idempotent, reversible and retain history', async () => {
  const db = new PGlite()
  try {
    const migration = readFileSync('migrations/2026-10-22_receptionist_phone_blocks.sql','utf8')
    await db.exec(migration); await db.exec(migration)
    const sql = { query: async (text, args) => (await db.query(text,args)).rows }
    const payload = { phone: '(317) 555-0123', blocked: true, reason:'Owner decision', confirmed:true, requestId:crypto.randomUUID() }
    const request = (data = payload) => new Request('https://example.com/api/receptionist/blocked-numbers',{method:'POST',body:JSON.stringify(data)})
    await assert.rejects(phoneBlockManagement(request(),sql,''), /Owner access/)
    await assert.rejects(phoneBlockManagement(request({...payload,confirmed:false}),sql,'owner'), /Confirm/)
    assert.equal((await phoneBlockManagement(request(),sql,'owner')).blocked,true)
    assert.equal((await phoneBlockManagement(request(),sql,'owner')).replay,true)
    await phoneBlockManagement(request({...payload,blocked:false,requestId:crypto.randomUUID()}),sql,'owner')
    await phoneBlockManagement(request(),sql,'owner')
    const result = await phoneBlockManagement(new Request('https://example.com/api/receptionist/blocked-numbers?phone=3175550123'),sql,'owner')
    assert.equal(result.rows.length,1)
    assert.equal(result.rows[0].blocked,false)
    assert.equal(result.history.length,2)
    await assert.rejects(phoneBlockManagement(request({...payload,phone:'3175550199'}),sql,'owner'), /already used/)
  } finally { await db.close() }
})
test('signed inbound calls reject only exact blocked numbers without overriding agent', async () => {
  const env = { RETELL_WEBHOOK_API_KEY:'synthetic-key',RETELL_TEST_PHONE:'+13175550100' }
  let reads=0
  const sql = { query: async (_text,args) => { reads++; return [{blocked:args[0]==='+13175550123'}] } }
  async function request(number, signatureValid=true, to=env.RETELL_TEST_PHONE) {
    const body = JSON.stringify({event:'call_inbound',call_inbound:{from_number:number,to_number:to}})
    const time=Date.now()
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.RETELL_WEBHOOK_API_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign'])
    const bytes = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body+time))
    const digest=Buffer.from(bytes).toString('hex')
    return new Request('https://example.com/api/receptionist/providers/retell/inbound',{method:'POST',body,headers:{'x-retell-signature':signatureValid?`v=${time},d=${digest}`:'invalid'}})
  }
  await assert.rejects(inboundPhoneBlock(await request('+13175550123',false),env,sql), /signature/)
  assert.equal(reads,0)
  await assert.rejects(inboundPhoneBlock(await request('+13175550123',true,'+13175550999'),env,sql), /destination/)
  assert.deepEqual(await inboundPhoneBlock(await request('+13175550123'),env,sql),{call_inbound:{reject:true}})
  assert.deepEqual(await inboundPhoneBlock(await request('+13175550124'),env,sql),{call_inbound:{}})
  assert.deepEqual(await inboundPhoneBlock(await request('anonymous'),env,sql),{call_inbound:{}})
})
