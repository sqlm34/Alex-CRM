// Explicit local acceptance harness. Never imports cloud configuration or connects
// to a persistent database. Exercises the actual React component and admin API.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';
import {nestwiseAdmin} from '../worker/nestwise-admin.mjs';

if(process.env.NESTWISE_UI_FIXTURE!=='1')throw Error('Set NESTWISE_UI_FIXTURE=1 for disposable local acceptance only');
const origin='http://127.0.0.1:8084',token='synthetic-local-only',db=new PGlite();
await db.exec(`create table jobs(id text primary key,payments jsonb default '[]',status text default 'new',paid boolean default false);
 create table offline_payments(id uuid primary key,job_id text references jobs,amount_cents integer,payment_date date,status text,method text,created_at timestamptz default now(),voided_at timestamptz,note text);
 create table parts_receipts(id text primary key,job_id text references jobs,status text,content_hash text,data jsonb,deleted_at timestamptz,confirmed_at timestamptz,created_by text);`);
for(const name of ['outbox','review','cost_corrections','lifecycle'])await db.exec(await readFile(new URL(`../migrations/2026-10-20_nestwise_${name}.sql`,import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../migrations/2026-10-28_nestwise_inventory_guard.sql',import.meta.url),'utf8'));
await db.exec(`insert into jobs(id) values('SYNTHETIC-cost'),('SYNTHETIC-complete'),('SYNTHETIC-retry');
 update nestwise_integration.configuration set capture_enabled=true;
 insert into parts_receipts(id,job_id,status,content_hash,data) values('synthetic-receipt','SYNTHETIC-cost','confirmed',repeat('a',64),'{"currency":"USD","expenseCents":3000}');
 insert into offline_payments(id,job_id,amount_cents,payment_date,status,method) values
 ('88000000-0000-4000-8000-000000000001','SYNTHETIC-complete',10000,'2026-10-10','succeeded','cash'),
 ('88000000-0000-4000-8000-000000000002','SYNTHETIC-retry',100,'2026-10-10','succeeded','cash');
 select nestwise_integration.process_changes();`);
const initial=(await db.query("select id from nestwise_integration.changes where job_id='SYNTHETIC-cost'")).rows[0];
await db.query('select nestwise_integration.confirm_source($1,$2,$3,$4,$5)',['88000000-0000-4000-8000-000000000003',initial.id,'fixture-owner','2026-10-10','Synthetic original payment acceptance']);
await db.exec(`update parts_receipts set data='{"currency":"USD","expenseCents":4500}';
 update jobs set status='complete' where id='SYNTHETIC-complete';select nestwise_integration.process_changes();`);
for(const event of (await db.query('select * from nestwise_integration.claim_delivery()')).rows){
 await db.query('select nestwise_integration.finish_delivery($1,$2,$3,$4,$5)',[event.id,event.lease_id,event.job_id==='SYNTHETIC-retry'?409:202,event.job_id==='SYNTHETIC-retry'?'rejected':'acked','posted']);
}
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {NestwiseSync} from './src/NestwiseSync';createRoot(document.getElementById('app')).render(<NestwiseSync token="${token}"/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'local-only-api',setup(b){
 b.onResolve({filter:/^\.\/api$/},args=>args.importer.endsWith('NestwiseSync.tsx')?{path:'local-api',namespace:'fixture'}:undefined);
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export async function nestwiseRequest(token,path,body,signal){const r=await fetch('/api/nestwise/'+path,{method:body===undefined?'GET':'POST',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Object.assign(new Error('Synthetic request failed'),{status:r.status});return r.json();}`,loader:'js'}));
}}]});
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM — synthetic integration acceptance</title><style>body{font:16px system-ui;background:#f3f6f5;color:#142c26;margin:0;padding:24px}main{max-width:900px;margin:auto}section,article{background:white;padding:20px;border:1px solid #cedbd5;border-radius:12px;margin:16px 0}button,input,textarea{font:inherit;padding:10px;margin:6px;max-width:100%;box-sizing:border-box}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}label{display:block;margin:12px 0}textarea{display:block;width:95%;min-height:90px}[role=alert]{color:#9c2020}pre{white-space:pre-wrap;overflow-wrap:anywhere}aside{padding:18px;background:#fff2b9;border-radius:12px}</style><main><aside><strong>SYNTHETIC LOCAL ACCEPTANCE</strong><p>Disposable data only. No connection to the live CRM, Nestwise service or actual payments. Original parts payment date: 2026-10-10.</p><button id="lose">Simulate one lost response after commit</button><span id="loss"></span></aside><div id="app"></div><button id="proof">Refresh database proof</button><pre id="result"></pre></main><script src="/bundle.js"></script><script>document.getElementById('lose').onclick=async()=>{await fetch('/fixture/lost-response',{method:'POST'});document.getElementById('loss').textContent='Next successful command will return a synthetic 503 after commit.'};document.getElementById('proof').onclick=async()=>{document.getElementById('result').textContent=JSON.stringify(await(await fetch('/fixture/proof')).json(),null,2)};</script></html>`;
if(process.argv.includes('--check')){
 const status=await nestwiseAdmin(new Request(origin+'/api/nestwise/sync'),{query:async(...args)=>(await db.query(...args)).rows},{id:'fixture-owner',role:'owner'});
 assert.equal(status.status,200);assert.equal(status.body.review,2);assert.equal(status.body.failed,1);
 assert.equal(bundle.outputFiles.length,1);assert.ok(bundle.outputFiles[0].contents.length>1000);
 await db.close();console.log('Synthetic UI fixture seeded and actual CRM component bundled; no listener or cloud access.');process.exit(0);
}
let dropNext=false;
const server=createServer(async(req,res)=>{
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 const send=(status,body,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(type==='application/json'?JSON.stringify(body):body);};
 try{
  if(req.headers.host!=='127.0.0.1:8084'||!['GET','POST'].includes(req.method)||req.method==='POST'&&req.headers.origin!==origin)return send(403,{error:'Local fixture only'});
  if(req.url==='/'&&req.method==='GET')return send(200,html,'text/html; charset=utf-8');
  if(req.url==='/bundle.js'&&req.method==='GET')return send(200,bundle.outputFiles[0].contents,'text/javascript');
  if(req.url==='/fixture/lost-response'&&req.method==='POST'){dropNext=true;return send(200,{armed:true});}
  if(req.url==='/fixture/proof'&&req.method==='GET'){
   const events=(await db.query('select job_id,order_revision,body::jsonb event from nestwise_integration.outbox order by job_id,order_revision')).rows;
   const audit={};for(const table of ['source_reviews','cost_corrections','lifecycle_reviews','operator_actions'])audit[table]=(await db.query(`select count(*)::int n from nestwise_integration.${table}`)).rows[0].n;
   return send(200,{synthetic:true,events,audit});
  }
  if(!req.url.startsWith('/api/nestwise/')||req.headers.authorization!=='Bearer '+token)return send(404,{error:'Not found'});
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>8192)return send(413,{error:'Too large'});chunks.push(part);}
  const request=new Request(origin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks)});
  const result=await nestwiseAdmin(request,{query:async(...args)=>(await db.query(...args)).rows},{id:'fixture-owner',role:'owner'});
  if(dropNext&&req.method==='POST'&&result.status===200){dropNext=false;return send(503,{error:'Synthetic lost response after commit'});}
  return send(result.status,result.body);
 }catch{return send(500,{error:'Synthetic fixture failure'});}
});
server.listen(8084,'127.0.0.1',()=>console.log('Synthetic CRM acceptance: '+origin));
async function close(){server.close();await db.close();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
