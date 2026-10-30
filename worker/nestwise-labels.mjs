import {dispatchAllowed} from './nestwise-delivery.mjs';
const path='/api/nestwise/order-labels';
const hex=bytes=>Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
export async function nestwiseLabels(request,sql,env,now=Date.now()) {
  const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  if(!dispatchAllowed(env,now))return reply({error:'unavailable'},503);
  if(request.method!=='POST'||new URL(request.url).pathname!==path||new URL(request.url).search)return reply({error:'not_found'},404);
  const timestamp=request.headers.get('x-nw-timestamp')??'',signature=request.headers.get('x-nw-signature')??'';
  if(request.headers.get('x-nw-key-id')!==env.NESTWISE_KEY_ID||request.headers.get('x-nw-connection')!==env.NESTWISE_CONNECTION
    ||!/^\d{10}$/.test(timestamp)||Math.abs(Math.floor(now/1000)-Number(timestamp))>60||! /^[a-f0-9]{64}$/.test(signature))return reply({error:'unauthorized'},401);
  let raw='';
  try {
    const reader=request.body?.getReader();if(!reader)throw Error();
    const chunks=[];let length=0;
    try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>24576){await reader.cancel();throw Error();}chunks.push(part.value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }catch{return reply({error:'invalid_body'},400);}
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(env.NESTWISE_SIGNING_SECRET.match(/../g),h=>parseInt(h,16)),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  // Purpose-separated read signature cannot be replayed as a financial event.
  const canonical=['nestwise-order-labels-v1','POST',path,env.NESTWISE_CONNECTION,env.NESTWISE_KEY_ID,timestamp,hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].join('\n');
  if(!await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),h=>parseInt(h,16)),new TextEncoder().encode(canonical)))return reply({error:'unauthorized'},401);
  let rows;
  try{rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length<1||rows.length>100||rows.some(r=>!r||Object.keys(r).sort().join(',')!=='event_id,order_id'||typeof r.order_id!=='string'||! /^[A-Za-z0-9_.:-]{1,128}$/.test(r.order_id)||typeof r.event_id!=='string'||! /^[a-f0-9-]{36}$/i.test(r.event_id)))throw Error();}catch{return reply({error:'invalid_request'},400);}
  try {
    const labels=await sql.query(`select distinct j.id order_id,left(j.customer,200) customer_name
      from jsonb_to_recordset($1::jsonb) as r(order_id text,event_id uuid)
      join nestwise_integration.outbox o on o.id=r.event_id and o.job_id=r.order_id
      join public.jobs j on j.id=o.job_id`,[JSON.stringify(rows)]);
    return reply({labels});
  }catch{return reply({error:'unavailable'},503);}
}
