import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const load = async () => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(read('../src/googleActionsAttribution.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64')}#${Math.random()}`)
const mod = await load()
const site = 'https://aleksappliancerepair.com/booking'
const now = Date.now(), ttl = mod.googleActionsLifetimeMs
test('Actions attribution decodes once, retains special characters, and replaces only with valid new referral', () => {
  const old = mod.resolveGoogleActionsAttribution(site+'?rwg_token=abc%2B%2F%3D&merchant_id=merchant-1',null,now)
  assert.equal(old.rwg_token,'abc+/=')
  assert.equal(old.merchant_id,'merchant-1')
  assert.equal(old.expires_at,now+ttl)
  assert.deepEqual(mod.resolveGoogleActionsAttribution(site,old,now+100),old)
  assert.deepEqual(mod.resolveGoogleActionsAttribution(site+'?rwg_token=abc%2B%2F%3D&merchant_id=merchant-1',old,now+100),old)
  assert.equal(mod.resolveGoogleActionsAttribution(site+'?rwg_token=new',old,now+100).captured_at,now+100)
  for(const query of ['?rwg_token=','?rwg_token=%00','?rwg_token=a&rwg_token=b','?rwg_token=%EF%BF%BD%20','?rwg_token=a&merchant_id=bad%20merchant']) {
    assert.deepEqual(mod.resolveGoogleActionsAttribution(site+query,old,now+100),old)
  }
  assert.equal(mod.resolveGoogleActionsAttribution(site+'?rwg_token='+'x'.repeat(16385),null,now),null)
  assert.equal(mod.resolveGoogleActionsAttribution(site.replace('/booking','/')+'?rwg_token=a',null,now),null)
})
test('30-day window: same day, day 29, exact expiry, future/malformed timestamps', () => {
  const item = mod.resolveGoogleActionsAttribution(site+'?rwg_token=a',null,now)
  assert.ok(mod.validGoogleActionsAttribution(item,now))
  assert.ok(mod.validGoogleActionsAttribution(item,now+29*86400000))
  assert.equal(mod.validGoogleActionsAttribution(item,now+ttl),null)
  for(const altered of [{captured_at:now+1},{expires_at:now+ttl+1},{captured_at:'0'},{expires_at:Infinity}]) {
    assert.equal(mod.validGoogleActionsAttribution({...item,...altered},now),null)
  }
})
function browser(href, blocked=false) {
  const store=new Map(), replacements=[]
  globalThis.window={location:{href},history:{state:{router:1},replaceState:(state,_,url)=>replacements.push({state,url})}}
  globalThis.localStorage={getItem:k=>store.get(k)||null,removeItem:k=>store.delete(k),setItem:(k,v)=>{if(blocked)throw Error('blocked');store.set(k,v)}}
  return {store,replacements}
}
test('capture precedes render, cleans only token after durable storage and preserves UTM/hash', async () => {
  const m=await load(), {store,replacements}=browser(site+'?utm_source=google&rwg_token=a%3D&foo=bar#step')
  m.captureGoogleActionsAttribution()
  assert.equal(JSON.parse(store.get(m.googleActionsStorageKey)).rwg_token,'a=')
  assert.deepEqual(replacements,[{state:{router:1},url:'/booking?utm_source=google&foo=bar#step'}])
  assert.match(read('../src/main.tsx'),/captureGoogleActionsAttribution\(\)[\s\S]*createRoot/)
  delete globalThis.window; delete globalThis.localStorage
})
test('disabled config makes no request; enabled exchanges once, persists receipt, booking ignores failures', async () => {
  const m=await load(), {store}=browser(site+'?rwg_token=private%3D')
  m.captureGoogleActionsAttribution()
  let calls=0
  const capture=async payload=>{calls++;return {attribution_id:'12345678-1234-1234-1234-123456789abc',captured_at:new Date(payload.captured_at).toISOString(),expires_at:new Date(payload.captured_at+ttl).toISOString()}}
  assert.equal(await m.prepareGoogleActionsAttribution(false,capture),undefined)
  assert.equal(calls,0)
  const ids=await Promise.all([m.prepareGoogleActionsAttribution(true,capture),m.prepareGoogleActionsAttribution(true,capture)])
  assert.equal(ids[0],ids[1]);assert.equal(calls,1)
  await m.prepareGoogleActionsAttribution(true,capture);assert.equal(calls,1)
  assert.equal(JSON.parse(store.get(m.googleActionsStorageKey)).rwg_token,'private=')
  const failing=await load();browser(site+'?rwg_token=b');failing.captureGoogleActionsAttribution()
  assert.equal(await failing.prepareGoogleActionsAttribution(true,async()=>{throw Error('network')}),undefined)
  assert.equal(await failing.prepareGoogleActionsAttribution(true,async()=>null),undefined)
  delete globalThis.window; delete globalThis.localStorage
})
test('receipt keeps original referral lifetime when the same token URL is reopened', async () => {
  const m=await load(),{store}=browser(site+'?rwg_token=replay')
  m.captureGoogleActionsAttribution()
  const before=JSON.parse(store.get(m.googleActionsStorageKey))
  await m.prepareGoogleActionsAttribution(true,async p=>({attribution_id:'12345678-1234-1234-1234-123456789abc',captured_at:new Date(p.captured_at).toISOString(),expires_at:new Date(p.captured_at+ttl).toISOString()}))
  m.captureGoogleActionsAttribution()
  const after=JSON.parse(store.get(m.googleActionsStorageKey))
  assert.equal(before.captured_at,after.captured_at);assert.equal(before.expires_at,after.expires_at)
  assert.ok(after.attribution_id)
  delete globalThis.window;delete globalThis.localStorage
})
test('new referral wins even when readable old storage cannot be overwritten', async () => {
  const m=await load();browser(site+'?rwg_token=old');m.captureGoogleActionsAttribution()
  globalThis.localStorage.setItem=()=>{throw Error('quota')}
  globalThis.window.location.href=site+'?rwg_token=new';m.captureGoogleActionsAttribution()
  let sent
  await m.prepareGoogleActionsAttribution(true,async p=>{sent=p.rwg_token;return null})
  assert.equal(sent,'new')
  delete globalThis.window;delete globalThis.localStorage
})
test('a new token during old capture is captured, not silently dropped at submission', async () => {
  const m=await load();browser(site+'?rwg_token=old');m.captureGoogleActionsAttribution()
  const requests=[];let finishOld
  const capture=p=>{requests.push(p.rwg_token);const r={attribution_id:'12345678-1234-1234-1234-123456789abc',captured_at:new Date(p.captured_at).toISOString(),expires_at:new Date(p.captured_at+ttl).toISOString()};return p.rwg_token==='old'?new Promise(resolve=>{finishOld=()=>resolve(r)}):Promise.resolve(r)}
  const old=m.prepareGoogleActionsAttribution(true,capture)
  globalThis.window.location.href=site+'?rwg_token=new';m.captureGoogleActionsAttribution()
  const newer=m.prepareGoogleActionsAttribution(true,capture)
  const id=await newer;finishOld()
  assert.equal(await old,id);assert.ok(id);assert.deepEqual(requests,['old','new'])
  delete globalThis.window;delete globalThis.localStorage
})
test('expired browser token storage is removed on next capture', async () => {
  const m=await load(),{store}=browser(site)
  store.set(m.googleActionsStorageKey,JSON.stringify({rwg_token:'expired',captured_at:now-ttl,expires_at:now}))
  m.captureGoogleActionsAttribution();assert.equal(store.has(m.googleActionsStorageKey),false)
  delete globalThis.window;delete globalThis.localStorage
})
test('blocked storage preserves memory and URL; raw referrer token is never sent to booking session', async () => {
  const m=await load(), {replacements}=browser(site+'?rwg_token=token',true)
  m.captureGoogleActionsAttribution();assert.equal(replacements.length,0)
  let token
  await m.prepareGoogleActionsAttribution(true,async payload=>{token=payload.rwg_token;return null})
  assert.equal(token,'token')
  assert.equal(m.bookingReferrerWithoutGoogleToken(site+'?rwg_token=secret&utm_source=google'),site+'?utm_source=google')
  const app=read('../src/App.tsx')
  assert.match(app,/referrer: bookingReferrerWithoutGoogleToken\(document.referrer\)/)
  assert.doesNotMatch(app,/rwg_token/)
  assert.match(app,/config.googleActionsCenterEnabled === true/)
  delete globalThis.window; delete globalThis.localStorage
})
