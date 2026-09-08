const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Pool } = require('pg');
// Opt-in locally with STRIPE_WEBHOOK_TEST_PORT; CI supplies a disposable PostgreSQL 17
// service. This suite resets only the dedicated loopback webhook_test database.
const root = path.resolve(__dirname, '..');
const { test: nodeTest } = require('node:test');
const testPort = Number(process.env.STRIPE_WEBHOOK_TEST_PORT || 0);
if (testPort && (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)) throw new Error('Invalid isolated test port');
const local = createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const worker = fs.readFileSync(path.join(root, 'worker/index.ts'), 'utf8');
const ast = ts.createSourceFile('worker.ts', worker, ts.ScriptTarget.Latest, true);
const names = ['handleStripeWebhook','verifyStripeWebhookSignature','timingSafeEqual',
  'systemUserForStripeAttempt','validateStripeIntentMatchesAttempt','recordSucceededStripePaymentAttempt',
  'stripePaymentDetailsFromIntent','normalizeStripeCardFunding','runSerializablePaymentTransaction',
  'isRetryableTransactionError','postgresErrorCode','sleep','ApiHttpError','verifyStripePaymentAttempt'];
const extracted = ast.statements.filter(n => n.name && names.includes(n.name.text));
assert.equal(extracted.length, names.length);
const code = ts.transpileModule(extracted.map(n=>n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
// No DATABASE_URL or production environment is used. Stripe retrieval is stubbed.
const pool = new Pool({host:'127.0.0.1',port:testPort || 5432,user:'webhook_test',password:'local-test-only',database:'webhook_test',max:8});
const secret = crypto.randomBytes(32).toString('hex');
let reads=0, stripeReads=0, commits=0, failLegacy=false, currentIntent;
const sql = {
  query: async (query, params) => {reads++;return (await pool.query(query,params)).rows;},
  transaction: async (callback,options) => {
    assert.equal(options.isolationLevel,'Serializable');
    const statements=callback({query:(query,params)=>({query,params})});
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result=[];
      for(const [i,s] of statements.entries()) {
        if(failLegacy && i===1) throw new Error('synthetic jobs write failure');
        result.push((await client.query(s.query,s.params)).rows);
      }
      await client.query('COMMIT');commits++;
      return result;
    } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  },
};
const runtime = new Function('getSql','json','retrieveStripePaymentIntent','loadFullJob','normalizeRole',
  'publicStripePaymentAttempt','normalizeJobForResponse',
  `${code}\nreturn { handler: handleStripeWebhook, verify: verifyStripePaymentAttempt };`)(
  ()=>sql,
  (body,request,env,status=200)=>Response.json(body,{status}),
  async()=>{stripeReads++;return structuredClone(currentIntent);},
  async(db,id)=>(await db.query('select * from jobs where id=$1::text',[id]))[0],
  role=>role,
  row=>row,
  job=>job,
);
const handler = runtime.handler;
const id='00000000-0000-4000-8000-000000000001';
const env={STRIPE_PAYMENT_ATTEMPTS_ENABLED:'true',STRIPE_WEBHOOK_SECRET:secret};
const baseIntent=()=>({id:'pi_synthetic_lab',amount:1000,currency:'usd',status:'succeeded',
  metadata:{job_id:'job-lab',payment_attempt_id:id},
  latest_charge:{id:'ch_synthetic_lab',balance_transaction:{id:'txn_synthetic_lab',fee:50,net:950},
    payment_method_details:{type:'card_present',card_present:{funding:'credit',brand:'visa'}}}});
const event=(type='payment_intent.succeeded',status='succeeded')=>({id:'evt_synthetic_lab',type,
  created:Math.floor(Date.now()/1000),data:{object:{...baseIntent(),status}}});
function request(payload, options={}) {
  const raw=typeof payload==='string'?payload:JSON.stringify(payload);
  const t=options.timestamp ?? Math.floor(Date.now()/1000);
  const sig=crypto.createHmac('sha256',options.secret??secret).update(`${t}.${raw}`).digest('hex');
  const header=options.header ?? `t=${t},${options.multiple?'v1='+('0'.repeat(64))+',':''}v1=${sig}`;
  return new Request('http://isolated.invalid/api/stripe/webhook',{method:'POST',body:options.tamper?raw+' ':raw,
    headers:{'stripe-signature':header,'content-type':'application/json'}});
}
async function send(e=event(),options={},settings=env){return handler(request(e,options),settings);}
async function state(){return {attempt:(await pool.query('select * from stripe_payment_attempts')).rows[0],job:(await pool.query('select * from jobs')).rows[0]};}
async function reset(){
  await pool.query('TRUNCATE stripe_payment_attempts, jobs, users CASCADE');
  await pool.query("insert into users values ('owner-lab','synthetic@example.invalid','Synthetic','local','owner','')");
  await pool.query("insert into jobs values ('job-lab',100,false,'[{\"lineTotalCents\":10000}]'::jsonb,'[]'::jsonb)");
  await pool.query(`insert into stripe_payment_attempts(id,job_id,created_by,idempotency_key,stripe_payment_intent_id,
    internal_status,stripe_status,desired_net_cents,charge_amount_cents) values($1::uuid,'job-lab','owner-lab',
    'synthetic-idempotency-lab','pi_synthetic_lab','processing','processing',1000,1000)`,[id]);
  reads=0;stripeReads=0;commits=0;failLegacy=false;currentIntent=baseIntent();
}
const results=[];
async function test(name,run){await reset();try{await run();results.push({name,pass:true});}
  catch(e){results.push({name,pass:false,error:e.message.slice(0,500),code:e.code});}
  console.log(JSON.stringify(results.at(-1)));
}
nodeTest('17 webhook regression scenarios with real isolated PostgreSQL', { skip: !testPort }, async()=>{
  try {
  const connection = (await pool.query('select current_database() as db, current_user as username')).rows[0];
  assert.deepEqual(connection, {db:'webhook_test',username:'webhook_test'});
  await pool.query(`create table if not exists public.users(id text primary key,email text,name text,provider text,role text,phone text);
    create table if not exists public.jobs(id text primary key,invoice numeric,paid boolean,finance_items jsonb,payments jsonb);`);
  await pool.query(fs.readFileSync(path.join(root,'migrations/2026-09-07_add_stripe_payment_attempts.sql'),'utf8'));
  await test('false flag: 200 disabled, zero DB or Stripe calls',async()=>{
    const r=await send(event(),{}, {...env,STRIPE_PAYMENT_ATTEMPTS_ENABLED:'false'});
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{received:false,disabled:true});assert.equal(reads+stripeReads,0);
  });
  await test('missing secret: controlled 503 and no side effects',async()=>{
    assert.equal((await send(event(),{}, {STRIPE_PAYMENT_ATTEMPTS_ENABLED:'true'})).status,503);assert.equal(reads+stripeReads,0);
  });
  await test('invalid signature and changed raw body rejected',async()=>{
    for(const options of [{secret:'wrong-test-secret'},{tamper:true},{header:''}])assert.equal((await send(event(),options)).status,400);
    assert.equal(reads+stripeReads,0);
  });
  await test('expired and future signatures rejected',async()=>{
    for(const delta of [-301,301])assert.equal((await send(event(),{timestamp:Math.floor(Date.now()/1000)+delta})).status,400);
    assert.equal(reads+stripeReads,0);
  });
  await test('multiple v1 signatures: valid member accepted',async()=>{
    assert.equal((await send(event(),{multiple:true})).status,200);assert.equal((await state()).job.payments.length,1);
  });
  await test('successful payment stored atomically with actual fee/net',async()=>{
    assert.equal((await send()).status,200);const s=await state();assert.equal(commits,1);
    assert.equal(s.job.payments.length,1);assert.equal(s.job.payments[0].amount,10);
    assert.equal(s.attempt.internal_status,'recorded');assert.equal(s.attempt.actual_fee_cents,50);assert.equal(s.attempt.actual_net_cents,950);
  });
  await test('duplicate deliveries never double count amount',async()=>{
    await send();await send();const s=await state();assert.equal(s.job.payments.length,1);assert.equal(s.job.payments[0].amount,10);
  });
  await test('duplicate delivery preserves original payment identity and timestamp',async()=>{
    await send();const before=(await state()).job.payments;await send();assert.deepEqual((await state()).job.payments,before);
  });
  await test('concurrent successful events do not double count',async()=>{
    const responses=await Promise.all([send(),send()]);assert.ok(responses.every(r=>r.status===200));assert.equal((await state()).job.payments.length,1);
  });
  await test('late failed/canceled events cannot downgrade recorded payment',async()=>{
    await send();currentIntent.status='requires_payment_method';
    await send(event('payment_intent.payment_failed','requires_payment_method'));
    currentIntent.status='canceled';await send(event('payment_intent.canceled','canceled'));
    await runtime.verify(sql,env,{id:'owner-lab'},(await state()).attempt);
    const s=await state();assert.equal(s.attempt.internal_status,'recorded');assert.equal(s.job.payments.length,1);
  });
  await test('failed then succeeded converges to recorded exactly once',async()=>{
    currentIntent.status='requires_payment_method';
    await send(event('payment_intent.payment_failed','requires_payment_method'));
    assert.equal((await state()).attempt.internal_status,'requires_payment_method');
    currentIntent=baseIntent();await send();const s=await state();
    assert.equal(s.attempt.internal_status,'recorded');assert.equal(s.job.payments.length,1);
  });
  await test('stale failure during retry does not release active reservation',async()=>{
    currentIntent.status='processing';await send(event('payment_intent.payment_failed','requires_payment_method'));
    const s=await state();
    let secondReservationAllowed=false;
    try {
      await pool.query(`insert into stripe_payment_attempts(id,job_id,created_by,idempotency_key,
        internal_status,desired_net_cents,charge_amount_cents) values($1::uuid,'job-lab','owner-lab',
        'synthetic-second-attempt','reserved',1000,1000)`,[crypto.randomUUID()]);
      secondReservationAllowed=true;
    }catch(e){if(e.code!=='23505')throw e;}
    assert.equal(secondReservationAllowed,false,
      `stale event changed status to ${s.attempt.internal_status}; second active reservation accepted while mocked Stripe remains processing`);
  });
  await test('legacy jobs update failure leaves no partial audit write',async()=>{
    failLegacy=true;await assert.rejects(()=>send(),/synthetic jobs write failure/);const s=await state();
    assert.equal(s.attempt.internal_status,'processing');assert.equal(s.job.payments.length,0);assert.equal(commits,0);
  });
  await test('audit update SQL failure does not write jobs.payments',async()=>{
    await pool.query(`create or replace function lab_fail_audit() returns trigger language plpgsql as $$ begin
      raise exception 'synthetic audit failure'; end; $$;
      create trigger lab_fail before update on stripe_payment_attempts for each row execute function lab_fail_audit();`);
    try {
      await assert.rejects(()=>send(),/synthetic audit failure/);
      const s=await state();assert.equal(s.job.payments.length,0);assert.equal(s.attempt.internal_status,'processing');assert.equal(commits,0);
    }finally{await pool.query('drop trigger lab_fail on stripe_payment_attempts; drop function lab_fail_audit();');}
  });
  await test('amount/currency/ownership mismatches rejected before write',async()=>{
    for(const patch of [{amount:999},{currency:'eur'},{metadata:{job_id:'other'}}]){
      const e=event();Object.assign(e.data.object,patch);await assert.rejects(()=>send(e),e=>e.status===409);
    }assert.equal(commits,0);assert.equal((await state()).job.payments.length,0);
  });
  await test('delayed actual fee/net is enriched on repeated verification',async()=>{
    currentIntent.latest_charge.balance_transaction=null;await send();
    const before=await state();assert.equal(before.attempt.actual_fee_cents,null);
    assert.equal(before.job.payments[0].processingFeeCents,null);
    currentIntent=baseIntent();
    await runtime.verify(sql,env,{id:'owner-lab'},before.attempt);
    const s=await state();assert.equal(s.attempt.actual_fee_cents,50);assert.equal(s.attempt.actual_net_cents,950);
    assert.equal(s.attempt.balance_transaction_id,'txn_synthetic_lab');
    assert.deepEqual(s.job,before.job);
    currentIntent.latest_charge.balance_transaction=null;await send();
    const afterMissing=await state();assert.equal(afterMissing.attempt.actual_fee_cents,50);
    assert.equal(afterMissing.attempt.actual_net_cents,950);assert.deepEqual(afterMissing.job,before.job);
  });
  await test('unknown PaymentIntent ignored without Stripe retrieval',async()=>{
    const e=event();e.data.object.id='pi_unknown_lab';assert.equal((await send(e)).status,200);assert.equal(stripeReads,0);assert.equal(commits,0);
  });
  assert.equal(results.length,17);
  assert.equal(results.filter(x=>!x.pass).length,0, JSON.stringify(results.filter(x=>!x.pass)));
  } finally { await pool.end(); }
});
