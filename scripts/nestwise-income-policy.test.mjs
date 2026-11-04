import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
const databaseURL=process.env.NESTWISE_CRM_TEST_DATABASE_URL;
function validatedDatabaseURL(){
 const url=new URL(databaseURL);
 assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/nestwise_crm_test','Only a disposable local nestwise_crm_test database is allowed');
 return url.href;
}

async function fixture() {
  let db;
  if(databaseURL){
    const client=new pg.Client({connectionString:validatedDatabaseURL()});await client.connect();
    await client.query('DROP SCHEMA IF EXISTS nestwise_integration CASCADE; DROP TABLE IF EXISTS public.offline_payments,public.stripe_payment_attempts,public.parts_receipts,public.jobs CASCADE');
    db={query:(...args)=>client.query(...args),exec:q=>client.query(q),close:()=>client.end(),transaction:async task=>{
      await client.query('BEGIN');try{const result=await task(db);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}
    }};
  }else db = new PGlite();
  await db.exec(`create table jobs(id text primary key,payments jsonb default '[]',status text default 'new',paid boolean default false);`);
  await db.exec(`create table offline_payments(id uuid primary key,job_id text references jobs,amount_cents integer,payment_date date,status text,method text,created_at timestamptz default now(),voided_at timestamptz,note text);`);
  await db.exec(`create table stripe_payment_attempts(id text primary key,job_id text references jobs,internal_status text,stripe_status text,charge_amount_cents integer,actual_fee_cents integer,actual_net_cents integer,currency text,metadata jsonb);
    create table parts_receipts(id text primary key,job_id text references jobs,status text,content_hash text,data jsonb,deleted_at timestamptz,confirmed_at timestamptz,created_by text);`);
  await db.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_outbox.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_review.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_cost_corrections.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_lifecycle.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-10-28_nestwise_inventory_guard.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-10-30_nestwise_customer_refunds.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/2026-11-04_nestwise_income_policy.sql', import.meta.url), 'utf8'));
  return db;
}


async function drain(db){for(let i=0;i<12;i++)await db.exec('select nestwise_integration.process_changes()');}
test('Done policy holds unfinished payments and releases once completed without inventing invoice payments',async()=>{
 const db=await fixture();try{
 await db.exec(`insert into jobs(id) values('unfinished'),('invoice-only');update nestwise_integration.configuration set capture_enabled=true,done_or_parts_enabled=true;
 insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values('88000000-0000-4000-8000-000000000001','unfinished',35500,'2026-11-03','succeeded','check');`);
 await drain(db);
 assert.equal((await db.query('select * from nestwise_integration.claim_delivery()')).rows.length,0);
 await db.exec("update jobs set status='complete' where id in ('unfinished','invoice-only')");await drain(db);
 const payments=(await db.query("select body::jsonb body from nestwise_integration.outbox where body::jsonb->>'type'='job.payment_recorded'")).rows;
 assert.equal(payments.length,1);assert.equal(payments[0].body.amount_cents,35500);assert.equal(payments[0].body.paid_at,'2026-11-03T00:00:00.000Z');
 assert.ok((await db.query('select * from nestwise_integration.claim_delivery()')).rows.some(r=>r.job_id==='unfinished'));
 await drain(db);assert.equal((await db.query("select count(*)::int n from nestwise_integration.outbox where body::jsonb->>'type'='job.payment_recorded'")).rows[0].n,1);
 }finally{await db.close();}
});
test('confirmed paid parts unblock the following advance while stock use never produces a second cash expense',async()=>{
 const db=await fixture();try{
 await db.exec(`alter table parts_receipts add column inventory_usage_id text;
 insert into jobs(id,status) values('advance','scheduled'),('stock','new');
 update nestwise_integration.configuration set capture_enabled=true,done_or_parts_enabled=true;
 insert into parts_receipts(id,job_id,status,content_hash,data) values('receipt','advance','draft',repeat('a',64),'{"date":"2026-11-03","currency":"USD","totalCents":9991,"expenseCents":9991}');
 update parts_receipts set status='confirmed' where id='receipt';
 insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values('88000000-0000-4000-8000-000000000002','advance',23000,'2026-11-03','succeeded','cash');
 insert into parts_receipts(id,job_id,status,content_hash,data,inventory_usage_id) values('stock-receipt','stock','confirmed','inventory:stock','{"currency":"USD","totalCents":961,"expenseCents":961}','stock-use');
 update jobs set status='complete' where id='stock';`);
 await drain(db);
 const events=(await db.query('select job_id,body::jsonb body from nestwise_integration.outbox')).rows;
 assert.equal(events.filter(r=>r.job_id==='advance'&&r.body.type==='job.part_cost_recorded').length,1);
 assert.equal(events.filter(r=>r.job_id==='advance'&&r.body.type==='job.payment_recorded').length,1);
 assert.equal(events.filter(r=>r.job_id==='stock'&&r.body.type==='job.part_cost_recorded').length,0);
 assert.equal((await db.query("select review_reason from nestwise_integration.order_streams where job_id='stock'")).rows[0].review_reason,null);
 await assert.rejects(db.exec('delete from nestwise_integration.policy_resolutions'),/immutable_nestwise_history/);
 await drain(db);assert.equal((await db.query('select count(*)::int n from nestwise_integration.outbox')).rows[0].n,events.length);
 }finally{await db.close();}
});

test('payment entered after Done drains its materialized job update exactly once; a changed amount remains held',async()=>{
 const db=await fixture();try{
 await db.exec(`insert into jobs(id) values('late-payment');update nestwise_integration.configuration set capture_enabled=true,done_or_parts_enabled=true;update jobs set status='complete' where id='late-payment'`);await drain(db);
 await db.exec(`insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values('88000000-0000-4000-8000-000000000005','late-payment',35500,'2026-11-04','succeeded','check');
 update jobs set payments='[{"id":"88000000-0000-4000-8000-000000000005","source":"offline","status":"succeeded","amount":"355.00"}]',paid=true where id='late-payment'`);await drain(db);
 assert.equal((await db.query("select review_reason from nestwise_integration.order_streams where job_id='late-payment'")).rows[0].review_reason,null);
 assert.equal((await db.query("select count(*)::int n from nestwise_integration.outbox where body::jsonb->>'type'='job.payment_recorded'")).rows[0].n,1);
 await db.exec(`update jobs set payments=jsonb_set(payments,'{0,amount}','"455.00"') where id='late-payment'`);await drain(db);
 assert.notEqual((await db.query("select review_reason from nestwise_integration.order_streams where job_id='late-payment'")).rows[0].review_reason,null);
 }finally{await db.close();}
});
