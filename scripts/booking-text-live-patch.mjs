import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
export function patchBookingTextWorker(original,helperSource){
 assert.ok(!original.includes('var bookingTextHelpers ='),'Already patched')
 const helper=ts.transpileModule(helperSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const prefix='var bookingTextHelpers = (() => { const exports = {};\n'+helper+'\nreturn exports; })();\n'
 const patches=[
 ['address: `${input2.address}, ${input2.zip}`,','address: bookingTextHelpers.serviceBookingAddress(input2.address, input2.zip),'],
 ['const payloadHash = await bookingPayloadHash({ ...job, issue:','const payloadHash = await bookingPayloadHash({ ...job, address: `${input2.address}, ${input2.zip}`, issue:'],
 ['if (address.length < 10) throw new ReceptionistError("Full street address required");','if (address.length < 10) throw new ReceptionistError("Full street address required");\n  try { bookingTextHelpers.serviceBookingAddress(address, zip); } catch { throw new ReceptionistError("Address ZIP does not match the confirmed ZIP"); }'],
 ['const bookingIssue = `${issue2}\n\nModel sticker photo(s): ${modelPhotoNames.join(", ")}`.slice(0, 1200);','const bookingIssue = issue2;'],
 ['    ...job,\n    ...Array.isArray(job.finance_items)', '    ...job,\n    ...typeof job.address === "string" ? { address: bookingTextHelpers.singleZipAddress(job.address) } : {},\n    ...typeof job.issue === "string" ? { issue: bookingTextHelpers.customerDescription(job.issue) } : {},\n    ...Array.isArray(job.finance_items)'],
 ]
 let output=original
 for(const [before,after] of patches){assert.equal(output.split(before).length-1,1,'Live code changed: '+before.slice(0,65));output=output.replace(before,after)}
 let restored=output
 for(const [before,after] of [...patches].reverse()){assert.equal(restored.split(after).length-1,1);restored=restored.replace(after,before)}
 assert.equal(restored,original,'Unrelated code changed')
 return prefix+output
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [input,output,expected]=process.argv.slice(2);assert(input&&output&&expected,'Provide input bundle, output bundle and expected live SHA256')
 const original=readFileSync(input,'utf8'),hash=createHash('sha256').update(original).digest('hex');assert.equal(hash,expected,'Live bundle changed')
 const patched=patchBookingTextWorker(original,readFileSync(new URL('../shared/booking-text.ts',import.meta.url),'utf8'));writeFileSync(output,patched)
 console.log(JSON.stringify({originalSha256:hash,patchedSha256:createHash('sha256').update(patched).digest('hex'),targetedEdits:5,unrelatedCodePreserved:true}))
}
