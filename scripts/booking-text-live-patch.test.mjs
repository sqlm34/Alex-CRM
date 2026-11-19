import {patchBookingTextWorker} from './booking-text-live-patch.mjs'
import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
const helper=readFileSync(new URL('../shared/booking-text.ts',import.meta.url),'utf8')
const fixture='// preserve current coverage, consent and signed webhook behavior\n'+[
 'address: `${input2.address}, ${input2.zip}`,',
 'const payloadHash = await bookingPayloadHash({ ...job, issue:',
 'if (address.length < 10) throw new ReceptionistError("Full street address required");',
 'const bookingIssue = `${issue2}\n\nModel sticker photo(s): ${modelPhotoNames.join(", ")}`.slice(0, 1200);',
 '    ...job,\n    ...Array.isArray(job.finance_items)',
].join('\n')
test('live patch preserves unrelated code and refuses an unknown, missing or repeated target',()=>{
 const result=patchBookingTextWorker(fixture,helper);assert.ok(result.includes('// preserve current coverage, consent and signed webhook behavior'))
 assert.ok(result.includes('address: `${input2.address}, ${input2.zip}`, issue:'))
 for(const changed of ['',fixture+fixture,result])assert.throws(()=>patchBookingTextWorker(changed,helper))
})
