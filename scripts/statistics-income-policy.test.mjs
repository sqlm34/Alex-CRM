import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
const exports={};
new Function('exports',ts.transpileModule(readFileSync(new URL('../worker/statisticsStorage.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);
test('all received cash is recognized regardless of job status or parts; invoice alone never does',async()=>{
 const db=new PGlite();try{
 await db.exec(`create table jobs(id text primary key, service_date date, status text, invoice numeric, finance_items jsonb default '[]', payments jsonb default '[]', booking_source text, booking_source_detail text);
 create table parts_receipts(id text primary key,job_id text references jobs(id),status text,data jsonb,deleted_at timestamptz,inventory_usage_id text);`);
 await db.transaction(async tx=>{for(const sql of exports.statisticsSchemaStatements)await tx.exec(sql)});
 await db.exec(`insert into jobs(id,service_date,status,invoice,payments) values ('advance','2026-12-10','scheduled',300,'[{"amount":230,"status":"succeeded","createdAt":"2026-11-03T15:00:00Z"}]'),('invoice-only','2026-11-03','complete',355,'[]');`);
 const report=async()=>(await db.query("select report from crm_monthly_statistics where month='2026-11-01'")).rows[0].report;
 assert.equal((await report()).received,23000);assert.equal((await report()).awaitingCompletion,0);
 await db.exec(`insert into parts_receipts values('parts','advance','confirmed','{"date":"2026-11-03","currency":"USD","expenseCents":9991,"totalCents":9991}',null,null)`);
 assert.equal((await report()).received,23000);assert.equal((await report()).awaitingCompletion,0);assert.equal((await report()).receivedParts,9991);assert.equal((await report()).receivedNet,13009);
 await db.exec("update parts_receipts set status='draft' where id='parts'");
 assert.equal((await report()).received,23000);
 await db.exec("update jobs set status='complete' where id='advance'");
 assert.equal((await report()).received,23000);
 await db.exec(`create schema nestwise_integration;create table nestwise_integration.outbox(job_id text,status text,body jsonb);
  update jobs set payments='[{"id":"paid-advance","source":"offline","amount":230,"status":"succeeded","createdAt":"2026-11-03T15:00:00Z"}]' where id='advance';
  insert into nestwise_integration.outbox values('advance','acked','{"type":"job.payment_recorded","source_fact_id":"offline:paid-advance"}');
  update jobs set status='canceled' where id='advance';`);
 assert.equal((await report()).received,23000,'a changed job status is not a cash refund');
 }finally{await db.close();}
});
