import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as cookies from 'tough-cookie'
import * as html from 'linkedom'
function load(file, deps = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports','require',code)(exports, name => { if (!(name in deps)) throw Error(name); return deps[name] })
  return exports
}
const auth = load('../worker/parts/supplierAuth.ts')
const { ReliableAccount } = load('../worker/parts/reliableAccount.ts', { './supplierAuth': auth })
const { MarconeAccount } = load('../worker/parts/marconeAccount.ts', { './supplierAuth': auth, 'tough-cookie':cookies, 'linkedom':html })
const signal = () => AbortSignal.timeout(1000)
test('sessions encrypted and bound to supplier/account scope', async () => {
  const key = '01'.repeat(32), session = {value:'test-session', expiresAt:Date.now()+60000}
  const sealed = await auth.sealSession(key,'reliable:account',session)
  assert.ok(!sealed.includes(session.value))
  assert.deepEqual(await auth.openSession(key,'reliable:account',sealed),session)
  await assert.rejects(auth.openSession(key,'marcone:account',sealed))
})
test('login uses observed endpoint and does not follow redirects', async () => {
  const token = `e30.${btoa(JSON.stringify({accountId:1,exp:Math.floor(Date.now()/1000)+600}))}.test`
  const adapter = new ReliableAccount(async (url, init) => {
    assert.equal(url,'https://reliableparts.net/us-api/accountapp/v1/security/api/auth/login')
    assert.equal(init.redirect,'manual')
    assert.deepEqual(JSON.parse(init.body),{username:'test',password:'test',redirectUrl:null})
    return Response.json({accessToken:token})
  })
  assert.equal((await adapter.login('test','test',signal())).value,token)
})
test('invalid credentials, account lock and human challenge stop without retries', async () => {
  for (const [status, expected] of [[401,'INVALID_CREDENTIALS'],[429,'ACCOUNT_LOCKED'],[403,'HUMAN_ACTION_REQUIRED']]) {
    let calls=0
    const adapter = new ReliableAccount(async()=>{calls++;return Response.json({}, {status})})
    await assert.rejects(adapter.login('test','test',signal()), e=>e.status===expected)
    assert.equal(calls,1)
  }
})
test('Reliable 404 distinguishes credential rejection from an unknown challenge without leaking response', async()=>{
  for (const [body,expected] of [['Invalid username or password: private provider detail','INVALID_CREDENTIALS'],['Not found','HUMAN_ACTION_REQUIRED']]) {
    const adapter=new ReliableAccount(async()=>new Response(body,{status:404}))
    await assert.rejects(adapter.login('test','test',signal()),e=>e.status===expected && !e.message.includes('private'))
  }
})
test('quotes never fall back to retail price or false public stock', async () => {
  const part={partNumber:'OEM',productUrl:'https://reliableparts.net/us/content/#/part/WPL%20%20OEM'}
  for (const partnerPrice of [undefined,12.34]) {
    const adapter=new ReliableAccount(async()=>Response.json([{productNumber:'OEM',manufacturerCode:'WPL',partnerPrice,retailPrice:99,inStock:false}]))
    const quote=await adapter.quote(part,{value:'test'},signal())
    assert.equal(quote.unitCostCents,partnerPrice===undefined?null:1234)
    assert.equal(quote.availability,'unknown')
  }
})

test('Marcone uses private cookie jar and only observed login fields', async()=>{
  let calls=0
  const account=new MarconeAccount(async(url,init)=>{
    calls++
    if (url.endsWith('/UserLogin')) return new Response('<input name="UserName"><input name="Password">',{headers:{'Set-Cookie':'session=test; Path=/; Secure; HttpOnly'}})
    assert.ok(url.endsWith('/UserLogin/DoLogin'))
    assert.equal(init.headers.Cookie,'session=test')
    assert.equal(new URLSearchParams(init.body).get('UserName'),'test-user')
    return Response.json({Result:true,SetShipToReadOnly:false})
  })
  assert.ok((await account.login('test-user','test-pass',signal())).value)
  assert.equal(calls,2)
})
test('Marcone challenges stop before submitting credentials, redirects cannot leak cookies',async()=>{
  let calls=0
  await assert.rejects(new MarconeAccount(async()=>{calls++;return new Response('captcha')}).login('test','test',signal()),e=>e.status==='HUMAN_ACTION_REQUIRED')
  assert.equal(calls,1)
  await assert.rejects(new MarconeAccount(async()=>new Response('',{status:302,headers:{Location:'https://example.com/'}})).login('test','test',signal()),e=>e.status==='HUMAN_ACTION_REQUIRED')
})
test('Marcone quote parses account price separately from retail, preserves unverified fit',async()=>{
  const account=new MarconeAccount(async()=>new Response('<a href="/UserLogin/Logout">Log Out</a><table><tr id="trListPrice"><td>$200.00</td></tr><tr id="trPrice"><td class="priceblock_ourprice">$96.71</td></tr></table><span class="a-color-success">412 In Stock</span>'))
  const jar=new cookies.CookieJar()
  const result=await account.quote({partNumber:'OEM',productUrl:'https://reliableparts.net/us/content/#/part/WPL%20%20OEM'},{value:JSON.stringify(await jar.serialize())},signal())
  assert.equal(result.unitCostCents,9671);assert.equal(result.quantity,412);assert.equal(result.compatibility,'not_verified')
})
