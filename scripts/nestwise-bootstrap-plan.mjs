// Produce SQL for the EMPTY isolated CRM database. Never connects to Neon.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';

export async function bootstrapPlan(){
  const db=new PGlite(),queries=[];
  const source=async(path)=>(await readFile(new URL('../'+path,import.meta.url),'utf8')).replaceAll('\r\n','\n');
  const base=await source('supabase-schema.sql');
  const text=await source('migrations/2026-09-04_add_independent_job_text_fields.sql');
  try{
    await db.exec(base);await db.exec(text);
    const bundle=await build({stdin:{contents:"export {default} from './worker/index.ts';export {attach} from '@neondatabase/serverless';",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'capture-auth-bootstrap',setup(b){
      b.onResolve({filter:/^@neondatabase\/serverless$/},()=>({path:'database',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export class Pool { constructor(){throw Error('Pool access forbidden in auth fixture');} } let query;export function attach(value){query=value;}export function neon(url){if(url!=='synthetic-only')throw Error('Unexpected database');return {query};}",loader:'js'}));
    }}]});
    const module=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=synthetic-crm-bootstrap.mjs').toString('base64'));
    module.attach(async(sql,args)=>{assert.ok(!args?.length,'Bootstrap must not embed credentials or user data');queries.push(sql);return (await db.query(sql,args)).rows;});
    // GET /auth/me initializes the real schema, then denies the absent session.
    const response=await module.default.fetch(new Request('https://fixture.invalid/api/auth/me'),{DATABASE_URL:'synthetic-only'});
    assert.equal(response.status,401);
    assert.ok(queries.some(sql=>sql.includes('create table if not exists auth_sessions')));
    const entries=[['supabase-schema.sql',base],['2026-09-04_add_independent_job_text_fields.sql',text],['worker-auth-bootstrap.sql',queries.join(';\n')]];
    for(const name of ['2026-09-06_add_offline_payments','2026-10-07_parts_receipts','2026-10-07_receipt_discard','2026-10-11_receipt_restore','2026-10-20_nestwise_outbox','2026-10-20_nestwise_review','2026-10-20_nestwise_cost_corrections','2026-10-20_nestwise_lifecycle'])entries.push([name+'.sql',await source('migrations/'+name+'.sql')]);
    let sql=`-- Generated from versioned CRM sources. Empty isolated database ONLY.
BEGIN;
SELECT pg_advisory_xact_lock(726498313);
DO $guard$ BEGIN
 IF current_database()<>'alex_crm_nestwise_staging' THEN RAISE EXCEPTION 'Wrong database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname IN ('public','nestwise_integration')) THEN RAISE EXCEPTION 'Database is not empty'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='alex_crm_nestwise_worker' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls) THEN RAISE EXCEPTION 'Unsafe or missing role'; END IF;
END $guard$;
GRANT CREATE ON DATABASE alex_crm_nestwise_staging TO alex_crm_nestwise_worker;
GRANT alex_crm_nestwise_worker TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE alex_crm_nestwise_worker;
CREATE TABLE public.crm_staging_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
`;
    for(const [name,body] of entries){
      const hash=createHash('sha256').update(body).digest('hex');
      sql+='\n-- '+name+'\n'+body.replace(/^\s*(begin|commit);\s*$/gim,'')+`\n;\nINSERT INTO public.crm_staging_migrations(version,sha256) VALUES ('${name}','${hash}');\n`;
    }
    sql+=`RESET ROLE;
REVOKE alex_crm_nestwise_worker FROM CURRENT_USER;
REVOKE CREATE ON DATABASE alex_crm_nestwise_staging FROM alex_crm_nestwise_worker;
COMMIT;
SELECT current_database(),(SELECT count(*) FROM public.crm_staging_migrations) AS migrations,(SELECT capture_enabled FROM nestwise_integration.configuration) AS capture_enabled;
`;
    return sql;
  }finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.stdout.write(await bootstrapPlan());
