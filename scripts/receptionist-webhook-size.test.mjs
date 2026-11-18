import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(relative) {
  const path = resolve(root, relative)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }
  cache.set(path, module.exports)
  const require = createRequire(path)
  new Function('require','exports','module',ts.transpileModule(readFileSync(path,'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(name => name.startsWith('.') ? load(resolve(dirname(path),`${name}.ts`)) : require(name),module.exports,module)
  return module.exports
}
const retell = load('worker/receptionist/retell.ts')
const { receptionistRoute } = load('worker/receptionist/routes.ts')
const { defaultReceptionistSettings } = load('shared/receptionist.ts')
const env = { AI_RECEPTIONIST_ENABLED:'true', AI_RECEPTIONIST_DEPLOYMENT:'preview', RETELL_WEBHOOK_API_KEY:'synthetic-webhook-secret', RETELL_AGENT_ID:'test-agent',RETELL_TEST_PHONE:'+13175550142' }
const path = '/providers/retell/webhook'
function request(raw, route = path, valid = true, headers = {}) {
  const timestamp = String(Date.now())
  const digest = createHmac('sha256',env.RETELL_WEBHOOK_API_KEY).update(raw+timestamp).digest('hex')
  return new Request('https://example.com/api/receptionist'+route, { method:'POST',body:raw,
    headers:{'x-retell-signature':valid ? `v=${timestamp},d=${digest}` : 'invalid',...headers} })
}
function dependencies() {
  const writes = []
  const queries = []
  return { writes, queries, deps: { owner: async () => { throw Error('Unexpected owner access') }, sql: { query: async (query, params = []) => {
    queries.push(query)
    if (query.includes('select settings,revision')) return [{settings:{...defaultReceptionistSettings,enabled:true,testMode:true,serviceZips:['46032'],publicPhone:env.RETELL_TEST_PHONE},revision:0}]
    if (query.includes('select call_id from receptionist_deleted_calls')) return []
    writes.push({query,params})
    return []
  } } } }
}
function payload(event, bytes) {
  const value = { event,call:{call_id:'call_large_synthetic',agent_id:env.RETELL_AGENT_ID,to_number:env.RETELL_TEST_PHONE,
    from_number:'+13175550143',direction:'inbound',call_type:'phone_call',call_status:'ended',duration_ms:25000,
    disconnection_reason:'user_hangup', transcript:'PRIVATE_TRANSCRIPT_',transcript_object:[{content:'PRIVATE_STRUCTURED_TRANSCRIPT'}],
    recording_url:'https://example.com/private-recording'} }
  const raw = JSON.stringify(value)
  value.call.transcript += 'x'.repeat(bytes - Buffer.byteLength(raw))
  return JSON.stringify(value)
}

for (const event of ['call_ended','call_analyzed']) test(`${event} accepts signed 1 MiB payload but persists metadata only`,async () => {
  const raw = payload(event,retell.RETELL_WEBHOOK_BODY_LIMIT)
  assert.equal(Buffer.byteLength(raw),1024*1024)
  const {writes,deps} = dependencies()
  const result = await receptionistRoute(request(raw),env,deps)
  assert.equal(result.status,200)
  assert.deepEqual(result.value,{received:true})
  assert.ok(writes.some(write => write.params.includes(event)))
  assert.ok(writes.some(write => write.params.includes(25000) && write.params.includes('user_hangup')))
  assert.doesNotMatch(JSON.stringify(writes),/PRIVATE_TRANSCRIPT_|PRIVATE_STRUCTURED_TRANSCRIPT|private-recording/)
})

test('webhook above 1 MiB rejects before database access even with misleading Content-Length',async () => {
  const {writes,queries,deps} = dependencies()
  const result = await receptionistRoute(request(payload('call_ended',1024*1024+1),path,true,{'content-length':'1'}),env,deps)
  assert.equal(result.status,413)
  assert.equal(writes.length,0)
  assert.equal(queries.length,0)
})

test('large tools retain 64 KiB cap; only exact webhook path gets larger allowance',async () => {
  assert.equal(retell.retellBodyLimit('/providers/retell/tools/requestCallback'),65536)
  assert.equal(retell.retellBodyLimit(path+'/extra'),65536)
  const {writes,queries,deps} = dependencies()
  const result = await receptionistRoute(request(payload('call_ended',65537),'/providers/retell/tools/requestCallback'),env,deps)
  assert.equal(result.status,413)
  assert.equal(writes.length,0)
  assert.equal(queries.length,0)
})

test('large invalid signature rejects before parsing malformed JSON or accessing database',async () => {
  const raw = '{'+ 'x'.repeat(100000)
  const {writes,queries,deps} = dependencies()
  assert.equal((await receptionistRoute(request(raw,path,false),env,deps)).status,401)
  assert.equal(writes.length,0)
  assert.equal((await receptionistRoute(request(raw),env,deps)).status,400)
  assert.equal(writes.length,0)
  assert.equal(queries.length,0)
})

test('stream limit counts UTF-8 bytes and cancels over-limit chunked input',async () => {
  let cancelled = false
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('\u00e9'.repeat(32769))) },cancel() {cancelled=true} })
  await assert.rejects(retell.limitedBody(new Request('https://example.com',{method:'POST',body:stream,duplex:'half'}),65536),error => error.status===413)
  assert.equal(cancelled,true)
})
