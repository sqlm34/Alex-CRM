import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import pg from 'pg';

const sourceURL=new URL(process.env.NESTWISE_CRM_TEST_DATABASE_URL||'');
assert.ok(['localhost','127.0.0.1'].includes(sourceURL.hostname)&&sourceURL.pathname==='/nestwise_crm_test',
  'Restore verification only accepts the disposable local CRM test database');
const restoredURL=new URL(sourceURL);restoredURL.pathname='/nestwise_crm_restore';
const source=new pg.Client({connectionString:sourceURL.href}),restored=new pg.Client({connectionString:restoredURL.href});
async function fingerprint(client){
 const tables=(await client.query("select schemaname,tablename from pg_tables where schemaname in ('public','nestwise_integration') order by schemaname,tablename")).rows;
 const result={};
 for(const {schemaname,tablename} of tables){
  assert.match(schemaname,/^[a-z_]+$/);assert.match(tablename,/^[a-z_]+$/);
  const rows=(await client.query(`select to_jsonb(t)::text row from "${schemaname}"."${tablename}" t order by to_jsonb(t)::text`)).rows;
  result[`${schemaname}.${tablename}`]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
 }
 return result;
}
try{
 await Promise.all([source.connect(),restored.connect()]);
 const expected=await fingerprint(source);
 for(const name of ['outbox','changes','delivery_attempts','operator_actions','source_reviews','cost_corrections'])assert.ok(expected[`nestwise_integration.${name}`]?.count>0,`Missing recovery evidence: ${name}`);
 assert.deepEqual(await fingerprint(restored),expected);
 for(const table of ['outbox','changes','delivery_attempts','operator_actions','source_reviews','cost_corrections']){
  await restored.query('BEGIN');
  try{await assert.rejects(restored.query(`delete from nestwise_integration.${table}`),/immutable_nestwise_history/);}
  finally{await restored.query('ROLLBACK');}
 }
 await restored.query('BEGIN');
 try{
  // The seeded stream is held for financial review, including after recovery.
  assert.equal((await restored.query('select * from nestwise_integration.claim_delivery()')).rows.length,0);
 }finally{await restored.query('ROLLBACK');}
 assert.deepEqual(await fingerprint(restored),expected);
 console.log('CRM source evidence, exact event bytes, delivery attempts and operator audit survived PostgreSQL restore.');
}finally{await Promise.all([source.end(),restored.end()]);}
