// Emit a reviewable, disabled configuration patch. Never reads secrets or deploys.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function productionPlan(startText, keyId) {
  const start=Date.parse(startText);
  assert.ok(Number.isFinite(start)&&new Date(start).toISOString()===startText,'Use an exact UTC ISO timestamp');
  assert.match(keyId??'',/^[a-z0-9-]{1,64}$/,'Use a key ID, never a secret');
  const migrations=[];
  for(const name of ['outbox','review','cost_corrections','lifecycle']){
    const path=`migrations/2026-10-20_nestwise_${name}.sql`;
    const body=(await readFile(new URL('../'+path,import.meta.url),'utf8')).replaceAll('\r\n','\n');
    migrations.push({path,sha256:createHash('sha256').update(body).digest('hex')});
  }
  const guardPath='migrations/2026-10-28_nestwise_inventory_guard.sql';
  const guard=(await readFile(new URL('../'+guardPath,import.meta.url),'utf8')).replaceAll('\r\n','\n');
  migrations.push({path:guardPath,sha256:createHash('sha256').update(guard).digest('hex')});
  return {
    purpose:'Review only; merge the patch into current live configuration, preserving all unrelated bindings and variables.',
    worker:'alex-crm-api',
    vars:{NESTWISE_ENVIRONMENT:'production',NESTWISE_PRODUCTION_APPROVED:'nestwise-production-v1',
      NESTWISE_DISPATCH_ENABLED:'false',NESTWISE_ENDPOINT:'https://nestwise.universestitch.com/v1/crm/events',
      NESTWISE_CONNECTION:'alex-crm-production',NESTWISE_KEY_ID:keyId,
      NESTWISE_DISPATCH_NOT_BEFORE:startText,NESTWISE_DISPATCH_EXPIRES_AT:new Date(start+30*86400000).toISOString()},
    serviceBinding:{binding:'NESTWISE_RECEIVER',service:'nestwise-production'},
    requiredSecretName:'NESTWISE_SIGNING_SECRET',migrations,
    gates:['Fresh source backup restored into a separate branch; verify data and migration hashes',
      'Apply versioned migrations with capture disabled; verify required optional source triggers',
      'Approve scoped production key, receiver account mapping and real-data transmission',
      'Verify exact revision CI and current live CRM configuration before deployment',
      'Enable only forward capture first; historical imports require separate reviewed preview',
      'Verify a real source event, its actual paid date and duplicate-safe receipt; then reconcile totals'],
    rollback:'Disable capture, sender and receiver; retain all source facts, outbox IDs, delivery attempts and financial history.'
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log(JSON.stringify(await productionPlan(process.argv[2],process.argv[3]),null,2));
}
