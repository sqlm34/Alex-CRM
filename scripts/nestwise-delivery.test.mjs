import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { deliverNestwise, dispatchNestwise, dispatchWindowOpen } from '../worker/nestwise-delivery.mjs';
const config = { enabled: true, endpoint: 'https://receiver.test/v1/crm/events', connection: 'crm-test', keyId: 'key-test', secret: 'ab'.repeat(32) };
const id = '88000000-0000-4000-8000-000000000001';
const body = JSON.stringify({ source_event_id: id });
const item = { id, body, body_hash: createHash('sha256').update(body).digest('hex') };
test('signed retries retain event bytes but refresh nonce; durable ACK matches event', async () => {
  const nonces = new Set();
  const fetcher = async (url, request) => {
    assert.equal(url, config.endpoint); assert.equal(request.redirect, 'error'); assert.equal(request.body, body);
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
test('disabled delivery, false ACK, transient errors and permanent conflicts are distinct', async () => {
  assert.equal((await deliverNestwise(item,{ enabled:false },()=>{throw Error('must not fetch');})).outcome,'disabled');
  for (const payload of [{ accepted:true,event_id:'wrong',duplicate:false,status:'posted' },{ accepted:true,event_id:id,duplicate:false,status:'unknown' }])
    assert.equal((await deliverNestwise(item,config,async()=>Response.json(payload,{status:202}))).outcome,'retry');
  for (const status of [401,429,503]) assert.equal((await deliverNestwise(item,config,async()=>new Response('',{status}))).outcome,'retry');
  assert.equal((await deliverNestwise(item,config,async()=>new Response('',{status:409}))).outcome,'rejected');
  assert.equal((await deliverNestwise(item,config,async()=>{throw Error('network');})).outcome,'retry');
  assert.equal((await deliverNestwise(item,config,async()=>new Response('x'.repeat(5000),{status:202}))).outcome,'retry');
  await assert.rejects(deliverNestwise({...item,body_hash:'bad'},config),/invalid_outbox_hash/);
});
