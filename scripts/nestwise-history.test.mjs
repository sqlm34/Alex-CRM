import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewHistory} from '../worker/nestwise-history.mjs';
test('history preview uses exact source cents, leaves unknown refunds explicit and never writes',async()=>{
 const sql={async query(text){assert.match(text,/^select /i);if(text.includes('from public.jobs'))return [{id:'job',payments:[{id:'p',amount:123.45,source:'offline',status:'succeeded'}]}];
  if(text.includes('offline_payments'))return [{id:'p',job_id:'job',amount_cents:'12345',status:'succeeded',payment_date:'2026-01-01'}];
  if(text.includes('to_regclass'))return [{available:true}];
  if(text.includes('parts_receipts'))return [{job_id:'job',expense_cents:'999',total_cents:'2000',currency:'USD'}];throw Error('unexpected query');}};
 const result=await previewHistory(sql);assert.equal(result.dry_run,true);assert.equal(result.totals.verified_offline_payments_cents,'12345');
 assert.equal(result.totals.confirmed_parts_evidence_cents,'999');assert.equal(result.orders[0].refunds_cents,null);
 assert.deepEqual(result.orders[0].issues,['parts_payment_date_requires_review']);assert.match(result.sha256,/^[0-9a-f]{64}$/);
 assert.equal(result.sha256,(await previewHistory(sql)).sha256);
});
test('history pagination and source mismatch cannot present uncertain amounts as verified',async()=>{
 const sql={async query(text){if(text.includes('from public.jobs'))return Array.from({length:51},(_,i)=>({id:'job'+String(i).padStart(3,'0'),payments:[{id:'p',amount:1.01,source:'offline',status:'succeeded'}]}));
  if(text.includes('offline_payments'))return [{id:'p',job_id:'job000',amount_cents:'100',status:'succeeded'}];return [{available:false}];}};
 const result=await previewHistory(sql);assert.equal(result.orders.length,50);assert.equal(result.next,'job049');
 assert.equal(result.totals.verified_offline_payments_cents,'0');assert.ok(result.orders[0].issues.includes('payment_amount_mismatch'));
 assert.ok(result.orders[0].issues.includes('parts_source_unavailable'));
});
