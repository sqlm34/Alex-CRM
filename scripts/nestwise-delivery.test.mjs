import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { deliverNestwise, dispatchNestwise } from '../worker/nestwise-delivery.mjs';
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
  await dispatchNestwise(sql,env,async()=>Response.json({accepted:true,event_id:id,duplicate:false,status:'needs_review'},{status:202}));
  assert.deepEqual(calls[1].args,[id,id,202,'acked','needs_review']);
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
