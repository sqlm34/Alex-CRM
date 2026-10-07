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
const shared = load('../shared/parts.ts')
const { ReliableCatalog } = load('../worker/parts/reliableCatalog.ts', { '../../shared/parts': shared })
const candidate = { productNumber: 'OLD', manufacturerCode: 'WPL', description: 'PUMP ASSEMBLY, DRAIN' }
const model = { rpmodel: { modelNumber: 'MODEL', manufacturer: 'Whirlpool', diagrams: [{ products: [candidate] }] } }
const input = { identity: { model: 'MODEL', brand: 'Whirlpool' }, intent: { searchTerms: ['drain pump'] } }
const signal = () => new AbortController().signal
test('real endpoint contract is read-only and never fabricates public price or availability', async () => {
  const requests = []
  const catalog = new ReliableCatalog(async (url, init) => {
    requests.push({url,init})
    return Response.json(init.method === 'GET' ? model : [{ ...candidate, productNumber: 'NEW', replacedPart: 'OLD', partnerPrice: 0, inStock: false }])
  })
  const result = await catalog.search(input, signal())
  assert.equal(result.results[0].partNumber,'NEW')
  assert.equal(result.results[0].unitCostCents,null)
  assert.equal(result.results[0].availability,'unknown')
  assert.equal(result.results[0].compatibility,'confirmed')
  assert.equal(requests.length,2)
  assert.equal(requests[1].url,'https://reliableparts.net/us-api/navapp/v1/product/search')
  assert.deepEqual(JSON.parse(requests[1].init.body),{products:[{productNumber:'OLD',manufacturerCode:'WPL'}]})
  assert.equal(requests[1].init.redirect,'manual')
})
test('cross-model, cross-brand, unrelated replacement and HTML login are rejected', async () => {
  for (const wrong of [{ ...model.rpmodel,modelNumber:'OTHER' },{ ...model.rpmodel,manufacturer:'Other' }]) {
    await assert.rejects(new ReliableCatalog(async()=>Response.json({rpmodel:wrong})).search(input,signal()),/INVALID_RESPONSE/)
  }
  await assert.rejects(new ReliableCatalog(async(_,init)=>Response.json(init.method==='GET'?model:[{...candidate,productNumber:'UNRELATED'}])).search(input,signal()),/INVALID_RESPONSE/)
  await assert.rejects(new ReliableCatalog(async()=>new Response('<html>Login</html>')).search(input,signal()),/INVALID_RESPONSE/)
})
test('missing model and unmatched component return no invented candidates', async () => {
  assert.equal((await new ReliableCatalog(async()=>Response.json({})).search(input,signal())).status,'MODEL_NOT_FOUND')
  const result=await new ReliableCatalog(async()=>Response.json(model)).search({...input,intent:{searchTerms:['compressor']}},signal())
  assert.equal(result.status,'PART_NOT_FOUND'); assert.deepEqual(result.results,[])
})
