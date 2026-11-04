import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
const exports={};
new Function('exports',ts.transpileModule(readFileSync(new URL('../src/paymentReview.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);
const {paymentReview}=exports;
test('completed order payment reminders distinguish missing, partial, full, refund and unloaded evidence',()=>{
 assert.equal(paymentReview('complete',355,'0').kind,'missing');
 assert.equal(paymentReview('complete',355,'15000').kind,'partial');
 assert.equal(paymentReview('complete',355,'35500'),null);
 assert.equal(paymentReview('complete',355,'40000'),null);
 assert.equal(paymentReview('scheduled',355,'0'),null);
 assert.equal(paymentReview('canceled',355,'0'),null);
 assert.equal(paymentReview('complete',0,'0'),null);
 assert.equal(paymentReview('complete',355,undefined),null);
 assert.equal(paymentReview('complete',355,'invalid'),null);
 assert.equal(paymentReview('complete',355,'0',true).kind,'refund');
});

test('Jobs query returns only scalar payment evidence and tolerates malformed, pending and void payments',async()=>{
 const db=new PGlite();try{
 const source=readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8');
 const fields=source.match(/const listFields = `([\s\S]*?)`/)[1];
 const summary=fields.slice(fields.indexOf('(select coalesce'),fields.indexOf('jobs.booking_source'));
 await db.exec(`create table jobs(payments jsonb);insert into jobs values('[{"amount":355,"status":"succeeded"},{"amount":200,"status":"pending"},{"amount":50,"voidedAt":"2026-11-04"},{"amount":"bad"},{"amount":10,"status":"refunded"}]')`);
 const row=(await db.query('select '+summary.replace(/,\s*$/,'')+' from jobs')).rows[0];
 assert.deepEqual(row,{recorded_payment_cents:'35500',has_refunded_payment:true});
 }finally{await db.close();}
});
