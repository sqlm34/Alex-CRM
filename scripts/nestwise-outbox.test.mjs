import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

async function fixture() {
  const db = new PGlite();
  await db.exec(`create table jobs(id text primary key,payments jsonb default '[]',status text default 'new',paid boolean default false);`);
  await db.exec(`create table offline_payments(id uuid primary key,job_id text references jobs,amount_cents integer,payment_date date,status text,method text,created_at timestamptz default now(),voided_at timestamptz,note text);`);
  await db.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_outbox.sql', import.meta.url), 'utf8'));
  return db;
}

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
