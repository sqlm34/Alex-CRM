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
test('both supplier lookups reuse public catalog resolution within one request only',async()=>{
  let count=0
  const request=async()=>{count++;return Response.json({})}
  const catalog=new ReliableCatalog(request)
  await Promise.all([catalog.search(input,signal()),catalog.search(input,signal())])
  assert.equal(count,1)
  await new ReliableCatalog(request).search(input,signal())
  assert.equal(count,2)
})
test('Maytag blank diagram descriptions are resolved before literal console matching', async () => {
  const calls=[]
  const parts=[{productNumber:'W10650404',manufacturerCode:'MAY',description:''},{productNumber:'BOARD',manufacturerCode:'MAY',description:''}]
  const catalog=new ReliableCatalog(async(url,init)=>{
    calls.push(url)
    if(init.method==='GET')return Response.json({rpmodel:{modelNumber:'MVWB835DW1',manufacturer:'Maytag',diagrams:[{diagramName:'CONSOLE AND DISPENSER PARTS',products:parts},{diagramName:'TOP AND CABINET PARTS',products:[{productNumber:'UNRELATED',manufacturerCode:'MAY',description:''}]}]}})
    const requested=JSON.parse(init.body).products[0].productNumber
    assert.notEqual(requested,'UNRELATED','AI filler words must not expand hydration into unrelated diagrams')
    return Response.json(requested==='W10650404'?[{productNumber:'W10861510',manufacturerCode:'WPL',replacedPart:'W10650404',description:'WHIRLPOOL WASHER CONTROL CONSOLE'}]:[{...parts[1],description:'Electronic control board'}])
  })
  const result=await catalog.search({identity:{brand:'Maytag',model:'MVWB835DW1'},intent:{canonicalPartType:'control_panel',searchTerms:['control board and panel'],literalTerm:'Control Console'}},signal())
  assert.equal(result.results.length,1)
  assert.equal(result.results[0].partNumber,'W10861510')
  assert.equal(result.results[0].compatibility,'confirmed')
  assert.ok(result.results[0].productUrl.includes('WPL%20%20W10861510'))
  assert.equal(calls.length,3,'resolved products must not be fetched twice')
})
test('literal words match partial catalog names in either order, but not partial words',async()=>{
  const products=['CONSOLE, CONTROL WHITE','Electronic control board','CONTROLLED CONSOLE'].map((description,i)=>({description,productNumber:`C${i}`,manufacturerCode:'WPL'}))
  const catalog=new ReliableCatalog(async(url,init)=>Response.json(init.method==='GET'?{rpmodel:{...model.rpmodel,diagrams:[{products}]}}:products.filter(p=>p.productNumber===JSON.parse(init.body).products[0].productNumber)))
  const result=await catalog.search({...input,intent:{canonicalPartType:'control_panel',searchTerms:['control board'],literalTerm:'control console'}},signal())
  assert.deepEqual(result.results.map(p=>p.partNumber),['C0'])
})
test('generic fan motor matches catalog motors, not their clips, grommets or unrelated motors', async () => {
  const products = ['MOTOR, FAN','MOTOR, CONDENSER FAN','MOTOR, EVAPORATOR','CLIP, FAN MOTOR','GROMMET, FAN MOTOR','MOTOR, DISPENSER'].map((description,i)=>({description,productNumber:`TEST${i}`,manufacturerCode:'WPL'}))
  const catalog = new ReliableCatalog(async (_url, init) => Response.json(init.method === 'GET' ? {rpmodel:{...model.rpmodel,diagrams:[{products}]}} : products.filter(p=>p.productNumber===JSON.parse(init.body).products[0].productNumber)))
  const result = await catalog.search({...input,intent:{canonicalPartType:'fan_motor',searchTerms:['fan motor','evaporator motor']}},signal())
  assert.deepEqual(result.results.map(p=>p.description),products.slice(0,3).map(p=>p.description))
})
test('model lookup exposes real Samsung revisions, keeps slash and never invents variants', async () => {
  const urls = []
  const catalog = new ReliableCatalog(async url => {
    urls.push(url)
    if (url.includes('/model/number/')) return new Response(null, { status: 204 })
    return Response.json({ modelsFound: 4, models: [
      { name: 'RF260BEAESG/AA-01', manufacturer: 'Samsung' },
      { name: 'RF260BEAESG/AA-02', manufacturer: 'Samsung' },
      { name: 'RF260BEAESG/AA-02', manufacturer: 'Samsung' },
      { name: 'RF260BEAESG/AA-03', manufacturer: 'Other' },
    ] })
  })
  const result = await catalog.findModels('rf260beaesg/aa-01', 'samsung', signal())
  assert.deepEqual(result.models.map(x => x.model), ['RF260BEAESG/AA-01', 'RF260BEAESG/AA-02'])
  assert.ok(result.models[0].diagramUrl.includes('RF260BEAESG%2FAA-01/Samsung'))
  assert.equal(urls.length, 3)
  assert.ok(urls[2].includes('q=RF260BEAESG%2FAA&'))
})
test('Kenmore formatting lookup preserves every digit and deduplicates candidates', async () => {
  const urls = []
  const catalog = new ReliableCatalog(async url => {
    urls.push(url)
    return Response.json(url.includes('/model/number/') ? {} : { models: [
      { name: '110.012345', manufacturer: 'Kenmore' },
      { name: '110.012345', manufacturer: 'Kenmore' },
      { name: '110.012345', manufacturer: 'Whirlpool' },
      { name: '110.12345', manufacturer: 'Kenmore' },
    ] })
  })
  assert.deepEqual((await catalog.findModels('110012345', 'Kenmore', signal())).models.map(x => x.model), ['110.012345'])
  assert.ok(urls[2].includes('q=110.012345&'))
})
test('exact model diagrams remain available without any part request; invalid/short lookup is rejected', async () => {
  const result = await new ReliableCatalog(async url => Response.json(url.includes('/model/number/') ? model : { models: [] })).findModels('MODEL', 'Whirlpool', signal())
  assert.equal(result.models.length, 1)
  assert.equal(result.models[0].model, 'MODEL')
  await assert.rejects(new ReliableCatalog(async () => { throw Error('must not fetch') }).findModels('123', 'Kenmore', signal()), /four model/)
  await assert.rejects(new ReliableCatalog(async () => new Response('login')).findModels('MODEL', 'Whirlpool', signal()), /INVALID_RESPONSE/)
})
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
  const empty=await new ReliableCatalog(async()=>new Response(null,{status:204})).search(input,signal())
  assert.equal(empty.status,'MODEL_NOT_FOUND'); assert.deepEqual(empty.results,[])
  assert.equal((await new ReliableCatalog(async()=>Response.json({})).search(input,signal())).status,'MODEL_NOT_FOUND')
  const result=await new ReliableCatalog(async()=>Response.json(model)).search({...input,intent:{searchTerms:['compressor']}},signal())
  assert.equal(result.status,'PART_NOT_FOUND'); assert.deepEqual(result.results,[])
})
test('default transport does not bind native fetch to connector instance', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async function () {
    assert.equal(this, undefined)
    return Response.json({})
  }
  try {
    assert.equal((await new ReliableCatalog().search(input, signal())).status, 'MODEL_NOT_FOUND')
  } finally { globalThis.fetch = previous }
})
