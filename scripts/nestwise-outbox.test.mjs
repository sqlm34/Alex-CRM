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
  return db;
}

test('PostgreSQL concurrent converters and senders never duplicate or leapfrog an order',{skip:!databaseURL},async()=>{
 const db=await fixture(),clients=[new pg.Client({connectionString:validatedDatabaseURL()}),new pg.Client({connectionString:validatedDatabaseURL()})];
 try{
  await db.exec(`insert into jobs(id) values('concurrent');update nestwise_integration.configuration set capture_enabled=true;
   insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values
    ('88000000-0000-4000-8000-000000000081','concurrent',100,'2026-10-19','succeeded','cash'),
    ('88000000-0000-4000-8000-000000000082','concurrent',200,'2026-10-20','succeeded','cash');`);
  await Promise.all(clients.map(c=>c.connect()));
  for(let round=0;round<2;round++)await Promise.all(clients.map(c=>c.query('select nestwise_integration.process_changes()')));
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.outbox')).rows[0].n,2);
  const claims=(await Promise.all(clients.map(c=>c.query('select * from nestwise_integration.claim_delivery()')))).flatMap(r=>r.rows);
  assert.equal(claims.length,1);assert.equal(claims[0].order_revision,1);
  const first=claims[0];
  await db.query('select nestwise_integration.finish_delivery($1,$2,202,$3,$4)',[first.id,first.lease_id,'acked','posted']);
  const next=(await Promise.all(clients.map(c=>c.query('select * from nestwise_integration.claim_delivery()')))).flatMap(r=>r.rows);
  assert.equal(next.length,1);assert.equal(next[0].order_revision,2);
  await db.exec(`insert into jobs(id) values('concurrent-cost');
   insert into parts_receipts(id,job_id,status,content_hash,data) values('concurrent-receipt','concurrent-cost','confirmed',repeat('a',64),'{"currency":"USD","expenseCents":1000}');
   select nestwise_integration.process_changes()`);
  const initial=(await db.query("select id from nestwise_integration.changes where job_id='concurrent-cost'")).rows[0];
  await db.query('select nestwise_integration.confirm_source($1,$2,$3,$4,$5)',['88000000-0000-4000-8000-000000000071',initial.id,'owner','2026-10-10','Synthetic concurrent original']);
  await db.exec(`update parts_receipts set data='{"currency":"USD","expenseCents":1200}' where id='concurrent-receipt';select nestwise_integration.process_changes()`);
  const changed=(await db.query("select id from nestwise_integration.changes where job_id='concurrent-cost' order by capture_revision desc limit 1")).rows[0];
  const confirmations=await Promise.allSettled(clients.map((client,i)=>client.query('select nestwise_integration.confirm_cost_correction($1,$2,$3,$4,$5)',[`88000000-0000-4000-8000-00000000007${i+2}`,changed.id,'owner','2026-10-10','Synthetic concurrent correction'])));
  assert.equal(confirmations.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(confirmations.filter(r=>r.status==='rejected').length,1);
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.cost_corrections')).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from nestwise_integration.outbox where job_id='concurrent-cost'")).rows[0].n,2);
 }finally{await Promise.all(clients.map(c=>c.end()));await db.close();}
});

test('Stripe and confirmed parts evidence is atomic, private and never invents payment dates',async()=>{
 const db=await fixture();try{
  await db.exec(`insert into jobs(id) values('evidence');update nestwise_integration.configuration set capture_enabled=true;
   insert into stripe_payment_attempts values('attempt','evidence','processing','processing',10000,null,null,'usd','{"private":"SECRET"}');
   insert into parts_receipts(id,job_id,status,data,created_by) values('receipt','evidence','draft','{"currency":"USD","expenseCents":3000,"supplier":"SECRET"}','SECRET');`);
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.changes')).rows[0].n,0);
  await assert.rejects(db.transaction(async tx=>{await tx.exec("update parts_receipts set status='confirmed'");throw new Error('rollback');}));
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.changes')).rows[0].n,0);
  await db.exec("update stripe_payment_attempts set internal_status='recorded',stripe_status='succeeded',actual_fee_cents=300,actual_net_cents=9700;update parts_receipts set status='confirmed',confirmed_at=now()");
  const changes=(await db.query('select * from nestwise_integration.changes order by capture_revision')).rows;
  assert.equal(changes.length,2);assert.equal(changes[0].after_data.fee_cents,'300');assert.equal(changes[1].after_data.expense_cents,'3000');
  assert.equal(JSON.stringify(changes).includes('SECRET'),false);assert.equal(changes[0].after_data.paid_at,undefined);
  await db.exec("update parts_receipts set data=data||'{\"supplier\":\"OTHER SECRET\"}'::jsonb");
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.changes')).rows[0].n,2);
  await db.exec('select nestwise_integration.process_changes()');
  assert.equal((await db.query('select review_reason from nestwise_integration.order_streams')).rows[0].review_reason,'source_requires_review');
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.outbox')).rows[0].n,0);
 }finally{await db.close();}
});

test('new payment on an existing financial order cannot bypass historical baseline review',async()=>{
 const db=await fixture();try{
  await db.exec(`insert into jobs(id,payments) values('historic','[{"id":"older","amount":100}]');
   insert into jobs(id) values('other');update nestwise_integration.configuration set capture_enabled=true;
   insert into offline_payments(id,job_id,amount_cents,payment_date,status,method)
    values('88000000-0000-4000-8000-000000000099','historic',1000,'2026-10-20','succeeded','cash');`);
  assert.equal((await db.query("select review_reason from nestwise_integration.order_streams where job_id='historic'")).rows[0].review_reason,'historical_baseline_required');
  await db.exec('select nestwise_integration.process_changes()');
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.outbox')).rows[0].n,0);
  await assert.rejects(db.exec("update offline_payments set job_id='other'"),/source_job_immutable/);
 }finally{await db.close();}
});

test('capture defaults off, rolls back with payment and excludes customer details', async () => {
  const db = await fixture();
  try {
    await db.exec(`insert into jobs(id) values('one');`);
    assert.equal((await db.query('select * from nestwise_integration.changes')).rows.length, 0);
    await db.exec('update nestwise_integration.configuration set capture_enabled=true');
    await assert.rejects(db.transaction(async tx => {
      await tx.exec(`update jobs set payments='[{"id":"p1","amount":10,"customerName":"PRIVATE"}]' where id='one'`);
      throw new Error('rollback');
    }));
    assert.equal((await db.query('select * from nestwise_integration.changes')).rows.length, 0);
    await db.exec(`update jobs set payments='[{"id":"p1","amount":10,"customerName":"PRIVATE"}]' where id='one'`);
    const changes = (await db.query('select * from nestwise_integration.changes')).rows;
    assert.equal(changes.length, 1);
    assert.equal(JSON.stringify(changes).includes('PRIVATE'), false);
    await db.exec(`update jobs set payments='[{"id":"p1","amount":10,"customerName":"CHANGED"}]' where id='one'`);
    assert.equal((await db.query('select * from nestwise_integration.changes')).rows.length, 1);
    await assert.rejects(db.exec('delete from nestwise_integration.changes'), /immutable/);
  } finally { await db.close(); }
});

test('offline capture preserves actual payment date and void evidence without interpreting it as a refund', async () => {
  const db=await fixture();
  try {
    await db.exec(`insert into jobs(id) values('offline');update nestwise_integration.configuration set capture_enabled=true;
      insert into offline_payments(id,job_id,amount_cents,payment_date,status,method,note)
        values('88000000-0000-4000-8000-000000000001','offline',12345,'2026-09-01','succeeded','cash','PRIVATE');`);
    let changes=(await db.query("select * from nestwise_integration.changes where source_kind='offline_payment' order by capture_revision")).rows;
    assert.equal(changes[0].after_data.payment_date,'2026-09-01');
    assert.equal(changes[0].after_data.amount_cents,'12345');
    assert.equal(JSON.stringify(changes).includes('PRIVATE'),false);
    await db.exec(`update offline_payments set note='OTHER PRIVATE'`);
    assert.equal((await db.query('select * from nestwise_integration.changes')).rows.length,1);
    await db.exec(`update offline_payments set status='voided',voided_at=now()`);
    changes=(await db.query('select * from nestwise_integration.changes order by capture_revision')).rows;
    assert.equal(changes[1].before_data.status,'succeeded');assert.equal(changes[1].after_data.status,'voided');
    assert.equal((await db.query('select * from nestwise_integration.outbox')).rows.length,0,'Capture must not invent a refund event');
  } finally { await db.close(); }
});

test('leases preserve ordering, reject stale ACKs and retain immutable retry bodies', async () => {
  const db = await fixture();
  try {
    await db.exec(`update nestwise_integration.configuration set capture_enabled=true;
      insert into jobs(id,status) values('one','completed');
      insert into nestwise_integration.outbox(id,job_id,order_revision,change_id,body,body_hash)
      select gen_random_uuid(),'one',n,c.id,'{"revision":'||n||'}',encode(sha256(convert_to('{"revision":'||n||'}','UTF8')),'hex')
      from nestwise_integration.changes c cross join generate_series(1,2) n;`);
    const first = (await db.query('select * from nestwise_integration.claim_delivery()')).rows;
    assert.equal(first.length, 1);
    assert.equal(first[0].order_revision, 1);
    assert.equal((await db.query('select * from nestwise_integration.claim_delivery()')).rows.length, 0);
    await db.exec(`update nestwise_integration.outbox set lease_until=now()-interval '1 second' where order_revision=1`);
    const retry = (await db.query('select * from nestwise_integration.claim_delivery()')).rows[0];
    assert.equal(retry.body, first[0].body);
    assert.notEqual(retry.lease_id, first[0].lease_id);
    const finish = async (lease, http, outcome, receiver) => (await db.query(
      'select nestwise_integration.finish_delivery($1,$2,$3,$4,$5) as ok', [retry.id,lease,http,outcome,receiver])).rows[0].ok;
    assert.equal(await finish(first[0].lease_id,202,'acked','posted'), false);
    await assert.rejects(finish(retry.lease_id,null,'acked','posted'), /invalid_ack/);
    assert.equal(await finish(retry.lease_id,202,'acked','waiting'), true);
    assert.equal((await db.query('select * from nestwise_integration.claim_delivery()')).rows[0].order_revision, 2);
    await assert.rejects(db.exec(`update nestwise_integration.outbox set body='changed'`), /immutable/);
    await db.exec(`update nestwise_integration.outbox set attempts=12,lease_until=now()-interval '1 second' where order_revision=2`);
    assert.equal((await db.query('select * from nestwise_integration.claim_delivery()')).rows.length, 0);
    assert.equal((await db.query('select status from nestwise_integration.outbox where order_revision=2')).rows[0].status, 'dlq');
    assert.equal((await db.query("select count(*)::int as n from nestwise_integration.delivery_attempts where outcome='lease_exhausted'")).rows[0].n, 1);
  } finally { await db.close(); }
});

test('source payment converts once, JSON materialization does not double revenue, corrections stop delivery', async () => {
  const db=await fixture();
  try {
    await db.exec(`update nestwise_integration.configuration set capture_enabled=true;
      insert into jobs(id) values('cash-job');
      insert into offline_payments(id,job_id,amount_cents,payment_date,status,method)
        values('88000000-0000-4000-8000-000000000001','cash-job',12345,'2026-09-01','succeeded','cash');
      update jobs set payments='[{"id":"88000000-0000-4000-8000-000000000001","source":"offline","status":"succeeded","amount":123.45}]',paid=true where id='cash-job';`);
    for(let i=0;i<4;i++)await db.query('select nestwise_integration.process_changes()');
    const events=(await db.query('select * from nestwise_integration.outbox')).rows;
    assert.equal(events.length,1);
    const event=JSON.parse(events[0].body);
    assert.equal(event.source_event_id,events[0].id);assert.equal(event.amount_cents,12345);
    assert.equal(event.type,'job.payment_recorded');assert.equal(event.paid_at,'2026-09-01T00:00:00.000Z');
    assert.equal(event.order_revision,1);
    assert.equal((await db.query('select processed_capture_revision from nestwise_integration.order_streams')).rows[0].processed_capture_revision,2);
    await db.exec(`update offline_payments set status='voided',voided_at=now()`);
    await db.query('select nestwise_integration.process_changes()');
    assert.equal((await db.query('select review_reason from nestwise_integration.order_streams')).rows[0].review_reason,'offline_correction_requires_review');
    assert.equal((await db.query('select * from nestwise_integration.claim_delivery()')).rows.length,0);
    assert.equal((await db.query('select * from nestwise_integration.outbox')).rows.length,1);
  } finally { await db.close(); }
});

test('unknown payment amounts and historical baselines are held without blocking another order', async()=>{
  const db=await fixture();
  try {
    await db.exec(`insert into jobs(id,payments) values('old','[{"id":"legacy","amount":10}]');
      update nestwise_integration.configuration set capture_enabled=true;
      update jobs set paid=true where id='old';
      insert into jobs(id,payments) values('invalid','[{"id":"p","source":"offline","amount":"bad","status":"succeeded"}]');
      insert into jobs(id) values('valid');
      insert into offline_payments(id,job_id,amount_cents,payment_date,status,method)
        values('88000000-0000-4000-8000-000000000002','valid',100,'2026-09-02','succeeded','cash');`);
    await db.query('select nestwise_integration.process_changes()');
    const streams=(await db.query('select job_id,review_reason from nestwise_integration.order_streams order by job_id')).rows;
    assert.deepEqual(streams,[{job_id:'invalid',review_reason:'payment_source_requires_review'},{job_id:'old',review_reason:'historical_baseline_required'},{job_id:'valid',review_reason:null}]);
    assert.equal((await db.query('select job_id from nestwise_integration.outbox')).rows[0].job_id,'valid');
  } finally { await db.close(); }
});

test('reviewed Stripe and parts sources retain evidence, ordered identities and retry safety',async()=>{
 const db=await fixture();try{
  await db.exec(`alter table stripe_payment_attempts add column stripe_payment_intent_id text;
   insert into jobs(id) values('review-stripe'),('review-parts');
   update nestwise_integration.configuration set capture_enabled=true;
   insert into stripe_payment_attempts(id,job_id,internal_status,stripe_status,charge_amount_cents,currency,stripe_payment_intent_id)
     values('attempt','review-stripe','processing','processing',10000,'usd','pi_test123');
   update stripe_payment_attempts set internal_status='recorded',stripe_status='succeeded',actual_fee_cents=300,actual_net_cents=9700;
   insert into parts_receipts(id,job_id,status,content_hash,data) values('receipt','review-parts','confirmed',repeat('a',64),'{"currency":"USD","expenseCents":3000}');
   select nestwise_integration.process_changes();`);
  const changes=(await db.query('select * from nestwise_integration.changes order by job_id')).rows;
  const stripe=changes.find(c=>c.source_kind==='stripe_attempt'),parts=changes.find(c=>c.source_kind==='parts_receipt');
  const args=['88000000-0000-4000-8000-000000000091',stripe.id,'owner','2026-10-10','Verified synthetic charge and fee payment'];
  const confirm=a=>db.query('select nestwise_integration.confirm_source($1,$2,$3,$4,$5)',a);
  await assert.rejects(confirm([...args.slice(0,3),null,args[4]]),/invalid_source_review/);
  await confirm(args);await confirm(args);
  await assert.rejects(confirm([...args.slice(0,3),'2026-10-11',args[4]]),/review_conflict/);
  const events=(await db.query("select body::jsonb as body from nestwise_integration.outbox where job_id='review-stripe' order by order_revision")).rows.map(r=>r.body);
  assert.deepEqual(events.map(e=>[e.type,e.amount_cents,e.order_revision]),[['job.payment_recorded',10000,1],['job.processor_fee_recorded',300,2]]);
  assert.ok(events.every(e=>e.paid_at==='2026-10-10T00:00:00.000Z'));
  assert.equal(JSON.stringify(events).includes(args[4]),false,'Operator evidence stays in CRM, not receiver payload');
  await db.exec(`update jobs set payments='[{"id":"materialized","source":"stripe_terminal","paymentIntentId":"pi_test123","amount":100,"status":"succeeded"}]' where id='review-stripe';select nestwise_integration.process_changes();`);
  assert.equal((await db.query("select review_reason from nestwise_integration.order_streams where job_id='review-stripe'")).rows[0].review_reason,null);
  assert.equal((await db.query("select count(*)::int n from nestwise_integration.outbox where job_id='review-stripe'")).rows[0].n,2);
  await confirm(['88000000-0000-4000-8000-000000000092',parts.id,'owner','2026-10-09','Verified synthetic parts purchase payment']);
  const part=(await db.query("select body::jsonb as body from nestwise_integration.outbox where job_id='review-parts'")).rows[0].body;
  assert.equal(part.type,'job.part_cost_recorded');assert.equal(part.settlement,'paid');assert.equal(part.amount_cents,3000);
  const review=(await db.query("select nestwise_integration.review_source('review-parts') as result")).rows[0].result;
  assert.equal(review.reviews.length,1);assert.equal(review.reviews[0].paid_on,'2026-10-09');
  await assert.rejects(db.exec('delete from nestwise_integration.source_reviews'),/immutable_nestwise_history/);
  await db.exec("update parts_receipts set data='{\"currency\":\"USD\",\"expenseCents\":4000}';select nestwise_integration.process_changes()");
  const correction=(await db.query("select id from nestwise_integration.changes where source_kind='parts_receipt' order by capture_revision desc limit 1")).rows[0];
  await assert.rejects(confirm(['88000000-0000-4000-8000-000000000093',correction.id,'owner','2026-10-09','Must not invent a correction']),/unsupported_source_review/);
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.source_reviews')).rows[0].n,2);
  const correctionArgs=['88000000-0000-4000-8000-000000000093',correction.id,'owner','2026-10-09','Correcting an entry error against the same paid receipt'];
  const correct=a=>db.query('select nestwise_integration.confirm_cost_correction($1,$2,$3,$4,$5)',a);
  await assert.rejects(correct([...correctionArgs.slice(0,3),'2026-10-10',correctionArgs[4]]),/unsupported_source_review/);
  await correct(correctionArgs);await correct(correctionArgs);
  await assert.rejects(correct([...correctionArgs.slice(0,4),'Changed evidence reference']),/review_conflict/);
  const costEvents=(await db.query("select body::jsonb body from nestwise_integration.outbox where job_id='review-parts' order by order_revision")).rows.map(r=>r.body);
  assert.equal(costEvents.length,2);assert.equal(costEvents[1].type,'job.cost_corrected');
  assert.equal(costEvents[1].amount_cents,4000);assert.equal(costEvents[1].reference_event_id,costEvents[0].source_event_id);
  assert.equal(costEvents[1].paid_at,costEvents[0].paid_at);
  await db.exec("update parts_receipts set data='{\"currency\":\"USD\",\"expenseCents\":0}';select nestwise_integration.process_changes()");
  const zero=(await db.query("select id from nestwise_integration.changes where source_kind='parts_receipt' order by capture_revision desc limit 1")).rows[0];
  await correct(['88000000-0000-4000-8000-000000000094',zero.id,'owner','2026-10-09','Correcting erroneous original amount to zero']);
  const last=(await db.query("select body::jsonb body from nestwise_integration.outbox where job_id='review-parts' order by order_revision desc limit 1")).rows[0].body;
  assert.equal(last.amount_cents,0);assert.equal(last.reference_event_id,costEvents[1].source_event_id);
  assert.equal((await db.query("select nestwise_integration.review_source('review-parts') result")).rows[0].result.corrections.length,2);
  await assert.rejects(db.exec('delete from nestwise_integration.cost_corrections'),/immutable_nestwise_history/);
  await db.exec("update parts_receipts set content_hash=repeat('b',64),data='{\"currency\":\"USD\",\"expenseCents\":2000}';select nestwise_integration.process_changes()");
  const changed=(await db.query("select id from nestwise_integration.changes where source_kind='parts_receipt' order by capture_revision desc limit 1")).rows[0];
  await assert.rejects(correct(['88000000-0000-4000-8000-000000000095',changed.id,'owner','2026-10-09','Different original must remain held']),/unsupported_source_review/);
  assert.equal((await db.query('select count(*)::int n from nestwise_integration.cost_corrections')).rows[0].n,2);
 }finally{await db.close();}
});

test('operator retry preserves event identity, is idempotent and cannot bypass financial review',async()=>{
 const db=await fixture();
 try{
  await db.exec(`update nestwise_integration.configuration set capture_enabled=true;insert into jobs(id) values('retry-job');
   insert into offline_payments(id,job_id,amount_cents,payment_date,status,method)
     values('88000000-0000-4000-8000-000000000003','retry-job',100,'2026-09-01','succeeded','cash');
   select nestwise_integration.process_changes();`);
  const item=(await db.query('select * from nestwise_integration.claim_delivery()')).rows[0];
  await db.query("select nestwise_integration.finish_delivery($1,$2,409,'rejected')",[item.id,item.lease_id]);
  const command='88000000-0000-4000-8000-000000000004';
  for(let i=0;i<2;i++)await db.query('select nestwise_integration.retry_delivery($1,$2,$3)',[item.id,command,'owner']);
  assert.equal((await db.query('select count(*)::int as n from nestwise_integration.operator_actions')).rows[0].n,1);
  const retry=(await db.query('select * from nestwise_integration.claim_delivery()')).rows[0];
  assert.equal(retry.body,item.body);assert.equal(retry.id,item.id);
  await db.query("select nestwise_integration.finish_delivery($1,$2,409,'rejected')",[retry.id,retry.lease_id]);
  await db.exec("update order_streams set review_reason='correction'".replace('order_streams','nestwise_integration.order_streams'));
  await assert.rejects(db.query('select nestwise_integration.retry_delivery($1,$2,$3)',[item.id,'88000000-0000-4000-8000-000000000005','owner']),/review_required/);
  const status=(await db.query('select nestwise_integration.sync_status() as s')).rows[0].s;
  assert.equal(status.failed,1);assert.equal(status.review,1);assert.equal(status.orders[0].events[0].id,item.id);
  await assert.rejects(db.exec('delete from nestwise_integration.operator_actions'),/immutable/);
  // Retain review audit evidence in the last fixture for CI dump/restore.
  await db.exec(`insert into jobs(id) values('restore-reviewed');
   insert into parts_receipts(id,job_id,status,content_hash,data) values('restore-receipt','restore-reviewed','confirmed',repeat('b',64),'{"currency":"USD","expenseCents":500}');
   select nestwise_integration.process_changes();select nestwise_integration.process_changes();`);
  const source=(await db.query("select id from nestwise_integration.changes where job_id='restore-reviewed' and source_kind='parts_receipt'")).rows[0];
  await db.query('select nestwise_integration.confirm_source($1,$2,$3,$4,$5)',['88000000-0000-4000-8000-000000000099',source.id,'owner','2026-10-10','Synthetic recovery proof']);
  await db.exec(`update parts_receipts set data='{"currency":"USD","expenseCents":600}' where id='restore-receipt';select nestwise_integration.process_changes()`);
  const changed=(await db.query("select id from nestwise_integration.changes where job_id='restore-reviewed' order by capture_revision desc limit 1")).rows[0];
  await db.query('select nestwise_integration.confirm_cost_correction($1,$2,$3,$4,$5)',['88000000-0000-4000-8000-000000000098',changed.id,'owner','2026-10-10','Synthetic corrected recovery proof']);
  await db.exec("update nestwise_integration.order_streams set review_reason='acceptance_hold' where job_id='restore-reviewed'");
 }finally{await db.close();}
});
