import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {nestwiseLabels} from '../worker/nestwise-labels.mjs';
const now=Date.now(),secret='ab'.repeat(32),path='/api/nestwise/order-labels';
const env={NESTWISE_ENVIRONMENT:'production',NESTWISE_PRODUCTION_APPROVED:'nestwise-production-v1',NESTWISE_DISPATCH_ENABLED:'true',NESTWISE_ENDPOINT:'https://nestwise.universestitch.com/v1/crm/events',NESTWISE_CONNECTION:'alex-crm-production',NESTWISE_KEY_ID:'test-key',NESTWISE_SIGNING_SECRET:secret,NESTWISE_RECEIVER:{fetch(){}},NESTWISE_DISPATCH_NOT_BEFORE:new Date(now-1000).toISOString(),NESTWISE_DISPATCH_EXPIRES_AT:new Date(now+60000).toISOString()};
const rows=[{order_id:'J-SYNTHETIC',event_id:'11111111-1111-4111-8111-111111111111'}];
function request(data=rows,seconds=Math.floor(now/1000),purpose='nestwise-order-labels-v1'){
 const body=JSON.stringify(data),timestamp=String(seconds),hash=createHash('sha256').update(body).digest('hex');
 const signature=createHmac('sha256',Buffer.from(secret,'hex')).update([purpose,'POST',path,env.NESTWISE_CONNECTION,env.NESTWISE_KEY_ID,timestamp,hash].join('\n')).digest('hex');
 return new Request('https://crm.invalid'+path,{method:'POST',headers:{'x-nw-connection':env.NESTWISE_CONNECTION,'x-nw-key-id':env.NESTWISE_KEY_ID,'x-nw-timestamp':timestamp,'x-nw-signature':signature},body});
}
test('labels require purpose-separated, fresh authentication before any database read',async()=>{
 let calls=0;const sql={query:async()=>{calls++;return [];}};
 for(const r of [request(rows,Math.floor(now/1000)-61),request(rows,Math.floor(now/1000),'v1'),new Request('https://crm.invalid'+path,{method:'POST',body:'[]'})])assert.equal((await nestwiseLabels(r,sql,env,now)).status,401);
 assert.equal(calls,0);
});
test('only bounded exact event-order pairs are queried and no financial writes occur',async()=>{
 let calls=0;const sql={query:async(text,args)=>{calls++;assert.match(text,/o.id=r.event_id and o.job_id=r.order_id/);assert.match(text,/^select distinct/);assert.deepEqual(JSON.parse(args[0]),rows);return [{order_id:rows[0].order_id,customer_name:'Synthetic Customer'}];}};
 assert.deepEqual(await (await nestwiseLabels(request(),sql,env,now)).json(),{labels:[{order_id:rows[0].order_id,customer_name:'Synthetic Customer'}]});
 assert.equal((await nestwiseLabels(request(Array(101).fill(rows[0])),sql,env,now)).status,400);
 assert.equal((await nestwiseLabels(request(),sql,{...env,NESTWISE_DISPATCH_ENABLED:'false'},now)).status,503);
 assert.equal(calls,1);
});
