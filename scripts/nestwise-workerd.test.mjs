import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';

test('actual Workers Request accepts signed transport options without following redirects',async()=>{
 const bundle=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),contents:`
 import {deliverNestwise} from './worker/nestwise-delivery.mjs';
 export default {async fetch(){
 const id='94000000-0000-4000-8000-000000000011',body=JSON.stringify({source_event_id:id});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),x=>x.toString(16).padStart(2,'0')).join('');
 const config={enabled:true,endpoint:'https://receiver.invalid/v1/crm/events',connection:'synthetic',keyId:'synthetic',secret:'ab'.repeat(32)};
 let calls=0;
 const result=await deliverNestwise({id,body,body_hash:hash},config,async(url,init)=>{
 calls++; const request=new Request(url,init);
 if(request.redirect!=='manual')throw Error('Redirect must never be followed');
 return new Response(null,{status:307,headers:{location:'https://untrusted.invalid'}});
 });
 return Response.json({result,calls});
 }};`},bundle:true,write:false,format:'esm',platform:'browser'});
 const runtime=new Miniflare({modules:true,compatibilityDate:'2026-05-23',script:bundle.outputFiles[0].text});
 try{const response=await runtime.dispatchFetch('http://localhost');assert.deepEqual(await response.json(),{result:{outcome:'retry',httpStatus:307,receiverStatus:null},calls:1});}
 finally{await runtime.dispose();}
});
