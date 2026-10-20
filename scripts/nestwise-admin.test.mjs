import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nestwiseAdmin} from '../worker/nestwise-admin.mjs';
const owner={id:'owner-id',role:'owner'},id='88000000-0000-4000-8000-000000000001';
const request=(path,body)=>new Request('https://crm.test/api/nestwise/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
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
});
