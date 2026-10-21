import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nestwiseAdmin} from '../worker/nestwise-admin.mjs';
const owner={id:'owner-id',role:'owner'},id='88000000-0000-4000-8000-000000000001';
const request=(path,body)=>new Request('https://crm.test/api/nestwise/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});

test('manual batch is owner-only, bounded and cannot accept delivery overrides',async()=>{
 const calls=[],sql={async query(text){calls.push(text);return text.includes('sync_status')?[{result:{pending:0}}]:[];}};
 const req=()=>new Request('https://crm.test/api/nestwise/dispatch',{method:'POST'});
 const env={NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_ENDPOINT:'https://receiver.test/v1/crm/events',
 NESTWISE_CONNECTION:'synthetic',NESTWISE_KEY_ID:'synthetic',NESTWISE_SIGNING_SECRET:'ab'.repeat(32),
 NESTWISE_DISPATCH_NOT_BEFORE:new Date(Date.now()-1000).toISOString(),NESTWISE_DISPATCH_EXPIRES_AT:new Date(Date.now()+60000).toISOString()};
 assert.equal((await nestwiseAdmin(req(),sql,{...owner,role:'technician'},env)).status,403);
 assert.equal((await nestwiseAdmin(req(),sql,owner)).status,409);
 assert.equal((await nestwiseAdmin(req(),sql,owner,{...env,NESTWISE_ENVIRONMENT:'production'})).status,409);
 assert.equal((await nestwiseAdmin(req(),sql,owner,{...env,NESTWISE_SIGNING_SECRET:undefined})).status,409);
 assert.equal((await nestwiseAdmin(request('dispatch',{endpoint:'https://other.test'}),sql,owner,env)).status,400);
 assert.equal((await nestwiseAdmin(new Request('https://crm.test/api/nestwise/dispatch?force=true',{method:'POST'}),sql,owner,env)).status,400);
 assert.equal(calls.length,0);
 assert.deepEqual(await nestwiseAdmin(req(),sql,owner,env),{status:200,body:{pending:0}});
 assert.equal(calls.length,3);
 assert.equal((await nestwiseAdmin(new Request('https://crm.test/api/nestwise/dispatch',{method:'POST',body:''}),sql,owner,env)).status,200);
});
test('sync admin rejects technician access, duplicate cursors and client-supplied actors',async()=>{
 const calls=[],sql={async query(text,args){calls.push(args);return [{result:{orders:[]}}];}};
 assert.equal((await nestwiseAdmin(request('sync'),sql,{...owner,role:'technician'})).status,403);assert.equal(calls.length,0);
 assert.equal((await nestwiseAdmin(request('sync?after=a&after=b'),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('retry',{event_id:id,command_id:id,actor:'spoofed'}),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('retry',{event_id:id,command_id:id}),sql,owner)).status,200);
 assert.deepEqual(calls[0],[id,id,owner.id]);
 assert.equal((await nestwiseAdmin(request('retry',{event_id:'x'.repeat(2000),command_id:id}),sql,owner)).status,413);
});
test('sync errors expose no database credentials or response bodies',async()=>{
 const secret='postgres://sensitive-test';
 const result=await nestwiseAdmin(request('sync'),{query:async()=>{throw new Error(secret);}},owner);
 assert.equal(result.status,503);assert.equal(JSON.stringify(result).includes(secret),false);
});

test('source review binds server actor and rejects malformed dates, extra fields and non-owners',async()=>{
 const calls=[],sql={async query(text,args){calls.push({text,args});return [{result:id}];}};
 const body={command_id:id,change_id:id,paid_on:'2026-10-10',evidence:'Synthetic original payment verified'};
 assert.equal((await nestwiseAdmin(request('source-review',body),sql,{...owner,role:'technician'})).status,403);
 assert.equal((await nestwiseAdmin(request('source-review',{...body,actor:'other'}),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('source-review',{...body,paid_on:'2026-02-30'}),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('source-review',{...body,evidence:'short'}),sql,owner)).status,400);
 assert.equal(calls.length,0);
 assert.deepEqual(await nestwiseAdmin(request('source-review',body),sql,owner),{status:200,body:{id}});
 assert.deepEqual(calls[0].args,[id,id,owner.id,body.paid_on,body.evidence]);
 assert.equal((await nestwiseAdmin(request('source-review?job=a&job=b'),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('source-review?job=order-1'),sql,owner)).status,200);
 const rejected=await nestwiseAdmin(request('source-review',body),{async query(){throw Error('unsupported_source_review')}},owner);
 assert.equal(rejected.status,409);
 const previous=calls.length;
 assert.equal((await nestwiseAdmin(request('source-correction',body),sql,{...owner,role:'technician'})).status,403);
 assert.equal((await nestwiseAdmin(request('source-correction',{...body,actor:'spoofed'}),sql,owner)).status,400);
 assert.equal(calls.length,previous);
 assert.deepEqual(await nestwiseAdmin(request('source-correction',body),sql,owner),{status:200,body:{id}});
 assert.match(calls.at(-1).text,/confirm_cost_correction/);
 assert.deepEqual(calls.at(-1).args,[id,id,owner.id,body.paid_on,body.evidence]);
 const lifecycle={command_id:id,change_id:id,action:'finalize',evidence:body.evidence};
 assert.equal((await nestwiseAdmin(request('lifecycle-review',lifecycle),sql,{...owner,role:'technician'})).status,403);
 assert.equal((await nestwiseAdmin(request('lifecycle-review',{...lifecycle,paid_on:'2026-10-10'}),sql,owner)).status,400);
 assert.equal((await nestwiseAdmin(request('lifecycle-review',{...lifecycle,action:'refund'}),sql,owner)).status,400);
 assert.deepEqual(await nestwiseAdmin(request('lifecycle-review',lifecycle),sql,owner),{status:200,body:{id}});
 assert.match(calls.at(-1).text,/confirm_lifecycle/);
 assert.deepEqual(calls.at(-1).args,[id,id,owner.id,'finalize',body.evidence]);
});
