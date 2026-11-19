import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import ts from 'typescript'
const text=readFileSync(new URL('../shared/booking-text.ts',import.meta.url),'utf8')
const helpers={};new Function('exports',ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(helpers)
const {singleZipAddress,serviceBookingAddress,customerDescription}=helpers

test('AI booking adds ZIP once whether the caller supplied it in the full address or separately',()=>{
 const base='123 Synthetic Street, Carmel, IN'
 assert.equal(serviceBookingAddress(base,'46032'),base+', 46032')
 for(const value of [base+' 46032',base+' 46032, 46032',base+' 46032, 46032, 46032'])assert.equal(serviceBookingAddress(value,'46032'),base+' 46032')
})
test('missing ZIP is appended without changing street, city or unit',()=>{
 assert.equal(serviceBookingAddress('123 Synthetic Street, Apt 4, Carmel, IN','46032'),'123 Synthetic Street, Apt 4, Carmel, IN, 46032')
 assert.equal(serviceBookingAddress('46032 Synthetic Street, Carmel, IN','46032'),'46032 Synthetic Street, Carmel, IN, 46032')
 assert.equal(serviceBookingAddress('123 Synthetic St, Apt 46032','46032'),'123 Synthetic St, Apt 46032, 46032')
 assert.equal(singleZipAddress('123 Synthetic St, Apt 46032, 46032'),'123 Synthetic St, Apt 46032, 46032')
})
test('postal suffix cleanup retains ZIP+4, country and matching house numbers',()=>{
 for(const [input,expected] of [
 ['46032 Synthetic Street, Carmel, IN 46032, 46032','46032 Synthetic Street, Carmel, IN 46032'],
 ['123 Synthetic St, IN 46032-1234, 46032, USA','123 Synthetic St, IN 46032-1234, USA'],
 ['123 Synthetic St, IN 46032, 46032-1234','123 Synthetic St, IN 46032-1234'],
 ['123 Synthetic St, IN 46032-1234, 46032-9999','123 Synthetic St, IN 46032-1234, 46032-9999'],
 ]){assert.equal(singleZipAddress(input),expected);assert.equal(singleZipAddress(expected),expected)}
 assert.throws(()=>serviceBookingAddress('123 Synthetic St, IN 46032','46250'),/does not match/)
})
test('description hides only generated standalone photo metadata and preserves customer symptoms',()=>{
 const issue='Freezer is warm.\nIt stopped cooling yesterday.'
 for(const suffix of ['\n\nModel sticker photo(s): IMG_0036.jpeg','\n\nAttached photos: model.jpg','\nPhotos attached.'])assert.equal(customerDescription(issue+suffix),issue)
 assert.equal(customerDescription('Attached photos show a crack.\nPlease check the door.'),'Attached photos show a crack.\nPlease check the door.')
})
test('existing job responses clean address and description without deleting stored text or attachments',()=>{
 const source=readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('worker.ts',source,ts.ScriptTarget.Latest,true)
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='normalizeJobForResponse')
 const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
 const response=new Function('singleZipAddress','customerDescription','normalizeServiceDateValue','normalizeServiceWindowValue',js+';return normalizeJobForResponse')(singleZipAddress,customerDescription,v=>v,v=>v)
 const job={address:'123 Synthetic St, IN 46032, 46032',issue:'Not cooling\n\nModel sticker photo(s): model.jpg',model_photo_attachments:[{id:'original-photo'}],invoice:89,payments:[{amount:89}]}
 const result=response(job)
 assert.equal(result.address,'123 Synthetic St, IN 46032');assert.equal(result.issue,'Not cooling')
 assert.deepEqual(result.model_photo_attachments,job.model_photo_attachments);assert.deepEqual(result.payments,job.payments)
 assert.match(job.address,/46032, 46032$/);assert.match(job.issue,/Model sticker/)
})
