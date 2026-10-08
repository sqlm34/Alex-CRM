import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import ts from 'typescript'
const exports={}
new Function('exports',ts.transpileModule(readFileSync(new URL('../src/visibleSupplierParts.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports)
const part={productUrl:'https://reliableparts.net/us/content/#/part/WPL%20%20W10724237',unitCostCents:null,availability:'unknown',quantity:null}
const response={supplier:'reliable',results:[part],suggestions:[{productUrl:part.productUrl}]}
test('hides only an unpriced unknown Reliable card already linked in suggestions',()=>{
  assert.equal(exports.visibleSupplierParts(response).length,0)
  for(const change of [{unitCostCents:0},{unitCostCents:2000},{availability:'in_stock'},{availability:'backorder'},{quantity:0}])
    assert.equal(exports.visibleSupplierParts({...response,results:[{...part,...change}]}).length,1)
})
test('keeps Marcone, unmatched links and model results without suggestions',()=>{
  assert.equal(exports.visibleSupplierParts({...response,supplier:'marcone'}).length,1)
  assert.equal(exports.visibleSupplierParts({...response,suggestions:[]}).length,1)
  assert.equal(exports.visibleSupplierParts({...response,suggestions:undefined}).length,1)
  assert.equal(exports.visibleSupplierParts({...response,suggestions:[{productUrl:'different'}]}).length,1)
})
