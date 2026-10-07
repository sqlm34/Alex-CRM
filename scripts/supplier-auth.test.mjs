import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
function load(file, deps = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports','require',code)(exports, name => { if (!(name in deps)) throw Error(name); return deps[name] })
  return exports
}
const auth = load('../worker/parts/supplierAuth.ts')
const { ReliableAccount } = load('../worker/parts/reliableAccount.ts', { './supplierAuth': auth })
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
test('quotes never fall back to retail price or false public stock', async () => {
  const part={partNumber:'OEM',productUrl:'https://reliableparts.net/us/content/#/part/WPL%20%20OEM'}
  for (const partnerPrice of [undefined,12.34]) {
    const adapter=new ReliableAccount(async()=>Response.json([{productNumber:'OEM',manufacturerCode:'WPL',partnerPrice,retailPrice:99,inStock:false}]))
    const quote=await adapter.quote(part,{value:'test'},signal())
    assert.equal(quote.unitCostCents,partnerPrice===undefined?null:1234)
    assert.equal(quote.availability,'unknown')
  }
})
