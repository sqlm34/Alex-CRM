import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';

test('fresh CRM schema, real password session and owner-only integration routes',async()=>{
  const db=new PGlite();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('Network forbidden in synthetic auth acceptance');};
  try{
    const bundle=await build({stdin:{contents:"export {default} from './worker/index.ts';export {attach} from '@neondatabase/serverless';",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'disposable-database',setup(b){
      b.onResolve({filter:/^@neondatabase\/serverless$/},()=>({path:'database',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"let db;export function attach(value){db=value;}export function neon(url){if(url!=='synthetic-only')throw Error('Unexpected database');return {query:async(text,args)=>(await db.query(text,args)).rows};}",loader:'js'}));
    }}]});
    const source=bundle.outputFiles[0].text+'\n//# sourceURL=synthetic-crm-auth-fixture.mjs';
    const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    module.attach(db);
    await db.exec(await readFile(new URL('../supabase-schema.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../migrations/2026-09-04_add_independent_job_text_fields.sql',import.meta.url),'utf8'));
    const env={DATABASE_URL:'synthetic-only',APPROVED_EMAILS:'owner@example.invalid',NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'false'};
    const request=(path,body,token)=>new Request('https://fixture.invalid/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const call=(path,body,token,bindings=env)=>module.default.fetch(request(path,body,token),bindings);
    const password='synthetic-test-password-only';
    const registered=await call('auth/register',{email:'owner@example.invalid',name:'Synthetic owner',password});
    assert.equal(registered.status,201,await registered.clone().text());
    const first=await registered.json();
    assert.ok(first.token);assert.equal(first.user.role,'owner');
    for(const migration of ['2026-09-06_add_offline_payments','2026-10-07_parts_receipts','2026-10-07_receipt_discard','2026-10-11_receipt_restore','2026-10-20_nestwise_outbox','2026-10-20_nestwise_review','2026-10-20_nestwise_cost_corrections','2026-10-20_nestwise_lifecycle']){
      await db.exec(await readFile(new URL(`../migrations/${migration}.sql`,import.meta.url),'utf8'));
    }
    assert.equal((await db.query('select capture_enabled from nestwise_integration.configuration')).rows[0].capture_enabled,false);
    assert.equal((await call('nestwise/sync')).status,401);
    assert.equal((await call('nestwise/sync',undefined,'invalid-token')).status,401);
    assert.equal((await call('nestwise/sync',undefined,first.token)).status,200);
    assert.equal((await call('nestwise/sync',undefined,first.token,{...env,NESTWISE_ENVIRONMENT:'production'})).status,404);
    assert.equal((await call('auth/login',{email:'owner@example.invalid',password:'incorrect'})).status,401);
    const login=await call('auth/login',{email:'owner@example.invalid',password});
    assert.equal(login.status,200);const session=await login.json();
    assert.equal((await call('auth/me',undefined,session.token)).status,200);
    await db.query("update users set role='technician' where email=$1",['owner@example.invalid']);
    assert.equal((await call('nestwise/sync',undefined,session.token)).status,403);
    await db.exec("update auth_sessions set expires_at=now()-interval '1 hour'");
    assert.equal((await call('nestwise/sync',undefined,session.token)).status,401);
    assert.equal((await db.query('select count(*)::int n from nestwise_integration.outbox')).rows[0].n,0);
  }finally{globalThis.fetch=originalFetch;await db.close();}
});
