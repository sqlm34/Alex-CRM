import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import ts from 'typescript'

function load(file, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  new Function('exports', 'require', code)(exports, name => {
    if (!(name in dependencies)) throw Error(`Unexpected import ${name}`)
    return dependencies[name]
  })
  return exports
}
const shared = load('../shared/parts.ts')
const { ReliableCatalog } = load('../worker/parts/reliableCatalog.ts', { '../../shared/parts': shared })
const start = Date.now()
const result = await new ReliableCatalog().search({
  identity: { brand: 'Whirlpool', model: 'WTW5057LW0' },
  intent: { canonicalPartType: 'drain_pump', searchTerms: ['drain pump', 'pump drain'] },
}, AbortSignal.timeout(25000))
assert.equal(result.status, 'SUCCESS')
assert(result.results.some(part => part.partNumber === 'W11399437' && part.replacedPartNumber === 'W11259498'))
assert(result.results.every(part => part.unitCostCents === null && part.availability === 'unknown'))
console.log(JSON.stringify({ durationMs: Date.now() - start, ...result }, null, 2))
