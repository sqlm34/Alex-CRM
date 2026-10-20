// Run with NESTWISE_SOURCE_DIR pointing to a compiled Nestwise checkout.
// Both databases are disposable in-memory instances; no credentials or network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {deliverNestwise} from '../worker/nestwise-delivery.mjs';

test('CRM capture → signed request → separate Nestwise journal → durable ACK; lost ACK never doubles cash',async()=>{
 assert.ok(process.env.NESTWISE_SOURCE_DIR,'Set NESTWISE_SOURCE_DIR to the Nestwise source checkout');
 const root=resolve(process.env.NESTWISE_SOURCE_DIR),require=createRequire(import.meta.url);
 const {createWorker}=require(join(root,'.test-build/worker/index.js'));
 const crm=new PGlite(),ledger=new PGlite();
 try{
  await crm.exec(`create table jobs(id text primary key,payments jsonb default '[]',status text default 'new',paid boolean default false);
    create table offline_payments(id uuid primary key,job_id text references jobs,amount_cents integer,payment_date date,status text,method text,created_at timestamptz default now(),voided_at timestamptz,note text);`);
  await crm.exec(await readFile(new URL('../migrations/2026-10-20_nestwise_outbox.sql',import.meta.url),'utf8'));
  for(const file of (await readdir(join(root,'db/migrations'))).filter(n=>/^\d+.*\.sql$/.test(n)).sort())await ledger.exec(await readFile(join(root,'db/migrations',file),'utf8'));
  const workspace=randomUUID(),account=randomUUID();
  await ledger.query('insert into nestwise.workspaces values($1,$2,$3)',[workspace,'Synthetic receiver','business']);
  await ledger.query('insert into nestwise.financial_accounts(id,workspace_id,name) values($1,$2,$3)',[account,workspace,'Synthetic clearing']);
  await ledger.query('insert into nestwise.source_connections values($1,$2,$3,true)',['crm-proof',workspace,account]);
  const secret=randomBytes(32).toString('hex'),now=Math.floor(Date.now()/1000);
  const env={ENVIRONMENT:'staging',FINANCIAL_INGESTION_ENABLED:'true',NESTWISE_DATABASE_URL:'in-memory-only',CRM_SERVICE_KEYS:JSON.stringify({'proof-key':{connectionId:'crm-proof',secret,notBefore:now-60,expiresAt:now+3600}})};
  const receiver=createWorker(()=>({accept:async(...args)=>(await ledger.query('select nestwise.accept_event($1,$2,$3,$4) result',args)).rows[0].result}));
  const config={enabled:true,endpoint:'https://receiver.test/v1/crm/events',connection:'crm-proof',keyId:'proof-key',secret};
  await crm.exec(`update nestwise_integration.configuration set capture_enabled=true;insert into jobs(id) values('synthetic-order');
    insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values
      ('88000000-0000-4000-8000-000000000011','synthetic-order',10000,'2026-09-01','succeeded','cash'),
      ('88000000-0000-4000-8000-000000000012','synthetic-order',25000,'2026-09-05','succeeded','check');
    select nestwise_integration.process_changes();select nestwise_integration.process_changes();`);
  const events=(await crm.query('select * from nestwise_integration.outbox order by order_revision')).rows;
  assert.equal(events.length,2);
  const send=(url,options)=>receiver.fetch(new Request(url,options),env);
  // Lost response after receiver commit, then a retry with a new request nonce.
  const lost=await deliverNestwise(events[0],config,async(url,options)=>{await send(url,options);throw Error('synthetic lost ACK');});
  assert.equal(lost.outcome,'retry');
  const first=await deliverNestwise(events[0],config,send);assert.equal(first.outcome,'acked');assert.equal(first.receiverStatus,'posted');
  const second=await deliverNestwise(events[1],config,send);assert.equal(second.outcome,'acked');
  // The event contract represents date-only payments at UTC midnight. Never cast
  // timestamptz directly to date in the database session's local timezone.
  await ledger.exec("set timezone='America/Indianapolis'");
  const rows=(await ledger.query(`select (paid_at at time zone 'UTC')::date::text as paid_on,sum(je.cents)::text as cents from nestwise.journal_transactions jt join nestwise.journal_entries je on je.transaction_id=jt.id where je.code='clearing' group by paid_at order by paid_at`)).rows;
  assert.deepEqual(rows,[{paid_on:'2026-09-01',cents:'10000'},{paid_on:'2026-09-05',cents:'25000'}]);
  assert.equal((await ledger.query('select count(*)::int n from nestwise.source_events')).rows[0].n,2);
  assert.equal((await crm.query("select count(*)::int n from information_schema.schemata where schema_name='nestwise'")).rows[0].n,0);
 }finally{await crm.close();await ledger.close();}
});
