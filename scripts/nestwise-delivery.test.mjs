import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { deliverNestwise, dispatchNestwise, dispatchWindowOpen, dispatchAllowed, nestwiseEnvironment } from '../worker/nestwise-delivery.mjs';
const config = { enabled: true, endpoint: 'https://receiver.test/v1/crm/events', connection: 'crm-test', keyId: 'key-test', secret: 'ab'.repeat(32) };
const id = '88000000-0000-4000-8000-000000000001';
const body = JSON.stringify({ source_event_id: id });
const item = { id, body, body_hash: createHash('sha256').update(body).digest('hex') };

test('compact production configuration preserves live bindings and delivers through the bound receiver',async()=>{
 const options={NESTWISE_ENVIRONMENT:'production',NESTWISE_PRODUCTION_APPROVED:'nestwise-production-v1',
  NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_ENDPOINT:'https://nestwise.universestitch.com/v1/crm/events',
  NESTWISE_CONNECTION:'alex-crm-production',NESTWISE_KEY_ID:'production-test',
  NESTWISE_DISPATCH_NOT_BEFORE:new Date(Date.now()-1000).toISOString(),
  NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+60000).toISOString()};
 let sent=0;const binding={async fetch(){sent++;return Response.json({accepted:true,event_id:id,duplicate:false,status:'waiting'},{status:202});}};
 const original={NESTWISE_CONFIG:JSON.stringify(options),NESTWISE_SIGNING_SECRET:config.secret,NESTWISE_RECEIVER:binding,DATABASE_URL:'unchanged',MCP_ENABLED:'true'};
 const env=nestwiseEnvironment(original);
 assert.equal(env.DATABASE_URL,original.DATABASE_URL);assert.equal(env.MCP_ENABLED,'true');assert.equal(env.NESTWISE_RECEIVER,binding);
 assert.equal(original.NESTWISE_DISPATCH_ENABLED,undefined);assert.equal(dispatchAllowed(env),true);
 const calls=[];
 await dispatchNestwise({async query(text,args){calls.push({text,args});return text.includes('claim_delivery')?[{...item,lease_id:id}]:[];}},env,()=>assert.fail('public fetch'));
 assert.equal(sent,1);assert.equal(calls.at(-1).args[3],'acked');
 assert.equal(dispatchAllowed(nestwiseEnvironment({...original,NESTWISE_DISPATCH_ENABLED:'false'})),false);
});
test('invalid compact configuration cannot enable dispatch or replace security-sensitive bindings',()=>{
 for(const value of ['{','null','[]','true','"text"','x'.repeat(4097),JSON.stringify({DATABASE_URL:'other'}),
 JSON.stringify({NESTWISE_SIGNING_SECRET:'other'}),JSON.stringify({NESTWISE_RECEIVER:'other'}),
 JSON.stringify({NESTWISE_DISPATCH_ENABLED:true}),'{"__proto__":{"polluted":true}}']){
  const env=nestwiseEnvironment({NESTWISE_CONFIG:value,NESTWISE_DISPATCH_ENABLED:'true',DATABASE_URL:'original',MCP_ENABLED:'true'});
  assert.equal(dispatchAllowed(env),false);assert.equal(env.DATABASE_URL,'original');assert.equal(env.MCP_ENABLED,'true');
 }
 const plain={NESTWISE_DISPATCH_ENABLED:'false'};assert.equal(nestwiseEnvironment(plain),plain);
});

function productionEnv() {
 return {NESTWISE_ENVIRONMENT:'production',NESTWISE_DISPATCH_ENABLED:'true',
  NESTWISE_PRODUCTION_APPROVED:'nestwise-production-v1',
  NESTWISE_ENDPOINT:'https://nestwise.universestitch.com/v1/crm/events',
  NESTWISE_CONNECTION:'alex-crm-production',NESTWISE_KEY_ID:'production-test',NESTWISE_SIGNING_SECRET:config.secret,
  NESTWISE_RECEIVER:{async fetch(){return Response.json({accepted:true,event_id:id,duplicate:false,status:'posted'},{status:202});}},
  NESTWISE_DISPATCH_NOT_BEFORE:new Date(Date.now()-1000).toISOString(),
  NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+86400000).toISOString()};
}

test('production fails closed before touching the database for incomplete or unsafe release profiles',async()=>{
 const env=productionEnv();assert.equal(dispatchAllowed(env),true);
 for(const override of [
  {NESTWISE_PRODUCTION_APPROVED:undefined},{NESTWISE_DISPATCH_ENABLED:'false'},
  {NESTWISE_ENDPOINT:'https://nestwise-staging.alexeasyrepair.workers.dev/v1/crm/events'},
  {NESTWISE_ENDPOINT:'https://receiver.test/v1/crm/events'},
  {NESTWISE_CONNECTION:'crm-synthetic-canary'},{NESTWISE_KEY_ID:''},{NESTWISE_SIGNING_SECRET:'bad'},
  {NESTWISE_RECEIVER:undefined},{NESTWISE_DISPATCH_NOT_BEFORE:undefined},
  {NESTWISE_DISPATCH_EXPIRES_AT:'invalid'},
  {NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()-2000).toISOString()},
  {NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+31*86400000).toISOString()},
 ]) {
  assert.equal(dispatchAllowed({...env,...override}),false);
  await dispatchNestwise({query(){assert.fail('invalid profile must not lease or process financial facts');}}, {...env,...override});
 }
 const start=Date.parse(env.NESTWISE_DISPATCH_NOT_BEFORE),end=start+30*86400000;
 env.NESTWISE_DISPATCH_EXPIRES_AT=new Date(end).toISOString();
 assert.equal(dispatchAllowed(env,start),true);assert.equal(dispatchAllowed(env,end-1),true);
 assert.equal(dispatchAllowed(env,start-1),false);assert.equal(dispatchAllowed(env,end),false);
});

test('production uses only the binding and persists the matching durable acknowledgement',async()=>{
 const env=productionEnv(),calls=[];
 env.NESTWISE_RECEIVER.fetch=async function(url,init){
  assert.equal(this,env.NESTWISE_RECEIVER);assert.equal(url,env.NESTWISE_ENDPOINT);
  assert.equal(init.headers['x-nw-connection'],'alex-crm-production');assert.equal(init.body,body);
  return Response.json({accepted:true,event_id:id,duplicate:true,status:'posted'},{status:202});
 };
 await dispatchNestwise({async query(text,args){calls.push({text,args});return text.includes('claim_delivery')?[{...item,lease_id:id}]:[];}},env,()=>assert.fail('public transport must not run'));
 assert.deepEqual(calls[2].args,[id,id,202,'acked','posted']);
});

test('production kill switch and expiry are rechecked after lease acquisition',async()=>{
 for(const override of [{NESTWISE_DISPATCH_ENABLED:'false'},{NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()-1).toISOString()}]) {
  const env=productionEnv();let calls=0;
  env.NESTWISE_RECEIVER.fetch=()=>assert.fail('disabled delivery must not send');
  await dispatchNestwise({async query(text){calls++;if(text.includes('claim_delivery')){Object.assign(env,override);return [{...item,lease_id:id}];}return [];}},env);
  assert.equal(calls,2,'lease must recover without a false acknowledgement');
 }
});

test('default transport retains the Worker global fetch receiver',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=function(){assert.equal(this,globalThis);return Promise.resolve(Response.json({accepted:true,event_id:id,duplicate:false,status:'posted'},{status:202}));};
  assert.equal((await deliverNestwise(item,config)).outcome,'acked');
 }finally{globalThis.fetch=original;}
});
test('signed retries retain event bytes but refresh nonce; durable ACK matches event', async () => {
  const nonces = new Set();
  const fetcher = async (url, request) => {
    assert.equal(url, config.endpoint); assert.equal(request.redirect, 'manual'); assert.equal(request.body, body);
    const h = request.headers; assert.equal(nonces.has(h['x-nw-nonce']), false); nonces.add(h['x-nw-nonce']);
    const canonical = ['v1','POST','/v1/crm/events',config.connection,config.keyId,h['x-nw-timestamp'],h['x-nw-nonce'],item.body_hash].join('\n');
    assert.equal(h['x-nw-signature'], createHmac('sha256', Buffer.from(config.secret,'hex')).update(canonical).digest('hex'));
    return Response.json({ accepted:true,duplicate:nonces.size>1,event_id:id,status:'waiting' }, { status:202 });
  };
  assert.equal((await deliverNestwise(item,config,fetcher)).outcome,'acked');
  assert.equal((await deliverNestwise(item,config,fetcher)).outcome,'acked');
});

test('dispatcher remains off outside staging and persists only matching leased outcomes', async () => {
  const calls=[];
  const sql={async query(text,args){calls.push({text,args});return text.includes('claim_delivery')?[{...item,lease_id:id}]:[];}};
  await dispatchNestwise(sql,{});await dispatchNestwise(sql,{NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_ENVIRONMENT:'production'});
  assert.equal(calls.length,0);
  const env={NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_ENVIRONMENT:'staging',NESTWISE_ENDPOINT:config.endpoint,NESTWISE_CONNECTION:config.connection,NESTWISE_KEY_ID:config.keyId,NESTWISE_SIGNING_SECRET:config.secret};
  env.NESTWISE_DISPATCH_NOT_BEFORE=new Date(Date.now()-1000).toISOString();
  env.NESTWISE_DISPATCH_EXPIRES_AT=new Date(Date.now()+60000).toISOString();
  await dispatchNestwise(sql,env,async()=>Response.json({accepted:true,event_id:id,duplicate:false,status:'needs_review'},{status:202}));
  assert.deepEqual(calls[2].args,[id,id,202,'acked','needs_review']);
});

test('acceptance dispatch requires a valid window of at most one hour', async () => {
  const start='2026-10-20T18:00:00Z', end='2026-10-20T19:00:00Z';
  const env={NESTWISE_DISPATCH_NOT_BEFORE:start,NESTWISE_DISPATCH_EXPIRES_AT:end};
  assert.equal(dispatchWindowOpen(env,Date.parse(start)),true);
  assert.equal(dispatchWindowOpen(env,Date.parse(end)-1),true);
  for(const now of [Date.parse(start)-1,Date.parse(end),NaN]) assert.equal(dispatchWindowOpen(env,now),false);
  for(const override of [{NESTWISE_DISPATCH_NOT_BEFORE:undefined},{NESTWISE_DISPATCH_EXPIRES_AT:'bad'},
    {NESTWISE_DISPATCH_EXPIRES_AT:start},{NESTWISE_DISPATCH_EXPIRES_AT:'2026-10-20T19:00:01Z'}])
    assert.equal(dispatchWindowOpen({...env,...override},Date.parse(start)),false);
  let calls=0;
  await dispatchNestwise({query(){calls++;}}, {NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'true'});
  assert.equal(calls,0,'missing window must not process or lease events');
});

test('expiration during lease acquisition does not send or acknowledge an event', async () => {
  const env={NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'true',
    NESTWISE_ENDPOINT:config.endpoint,NESTWISE_CONNECTION:config.connection,NESTWISE_KEY_ID:config.keyId,
    NESTWISE_SIGNING_SECRET:config.secret,NESTWISE_DISPATCH_NOT_BEFORE:new Date(Date.now()-1000).toISOString(),
    NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+60000).toISOString()};
  const calls=[];
  await dispatchNestwise({async query(text){calls.push(text);if(text.includes('claim_delivery')){
    env.NESTWISE_DISPATCH_EXPIRES_AT=new Date(Date.now()-1).toISOString();return [{...item,lease_id:id}];
  }return [];}},env,()=>{assert.fail('expired window must not send');});
  assert.equal(calls.length,2);
});

test('service binding preserves its receiver and signed request while bypassing public fetch',async()=>{
 let sent=0;const binding={async fetch(url,options){assert.equal(this,binding);assert.equal(url,config.endpoint);
 assert.equal(options.headers['x-nw-connection'],config.connection);assert.equal(options.body,body);sent++;
 return Response.json({accepted:true,event_id:id,duplicate:true,status:'posted'},{status:202});}};
 const calls=[],sql={async query(text,args){calls.push({text,args});return text.includes('claim_delivery')?[{...item,lease_id:id}]:[];}};
 await dispatchNestwise(sql,{NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_RECEIVER:binding,
 NESTWISE_ENDPOINT:config.endpoint,NESTWISE_CONNECTION:config.connection,NESTWISE_KEY_ID:config.keyId,NESTWISE_SIGNING_SECRET:config.secret,
 NESTWISE_DISPATCH_NOT_BEFORE:new Date(Date.now()-1000).toISOString(),NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+60000).toISOString()},()=>assert.fail('must use configured binding'));
 assert.equal(sent,1);assert.deepEqual(calls[2].args,[id,id,202,'acked','posted']);
});
test('disabled delivery, false ACK, transient errors and permanent conflicts are distinct', async () => {
  assert.equal((await deliverNestwise(item,{ enabled:false },()=>{throw Error('must not fetch');})).outcome,'disabled');
  for (const payload of [{ accepted:true,event_id:'wrong',duplicate:false,status:'posted' },{ accepted:true,event_id:id,duplicate:false,status:'unknown' }])
    assert.equal((await deliverNestwise(item,config,async()=>Response.json(payload,{status:202}))).outcome,'retry');
  for (const status of [301,302,307,308,401,429,503]) assert.equal((await deliverNestwise(item,config,async()=>new Response('',{status}))).outcome,'retry');
  assert.equal((await deliverNestwise(item,config,async()=>new Response('',{status:409}))).outcome,'rejected');
  assert.equal((await deliverNestwise(item,config,async()=>{throw Error('network');})).outcome,'retry');
  assert.equal((await deliverNestwise(item,config,async()=>new Response('x'.repeat(5000),{status:202}))).outcome,'retry');
  await assert.rejects(deliverNestwise({...item,body_hash:'bad'},config),/invalid_outbox_hash/);
});
