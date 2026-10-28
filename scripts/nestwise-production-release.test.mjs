import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseMetadata,verifyCandidate,soleVersion} from './nestwise-production-release.mjs';
const baseline=()=>({resources:{script_runtime:{compatibility_date:'2026-05-23',compatibility_flags:['nodejs_compat']},
  script:{handlers:['fetch','scheduled']},bindings:[{name:'DATABASE_URL',type:'secret_text'},
    {name:'MCP_CONFIG',type:'plain_text',text:'existing'},
    {name:'ATTACHMENTS_BUCKET',type:'r2_bucket',bucket_name:'existing-production'},
    {name:'SERVICE',type:'service',service:'existing-service'}]}});
test('inert release preserves live configuration and secret metadata without copying secret values',()=>{
  const before=baseline(), original=structuredClone(before), metadata=releaseMetadata(before);
  assert.deepEqual(before,original);
  assert.deepEqual(metadata.keep_bindings,['secret_text','secret_key']);
  assert.equal(metadata.bindings.some(b=>b.name==='DATABASE_URL'),false);
  const after=structuredClone(before);
  after.resources.bindings.push(metadata.bindings.find(b=>b.name==='NESTWISE_DISPATCH_ENABLED'));
  verifyCandidate(before,after);
  assert.equal(after.resources.bindings.at(-1).text,'false');
});
test('release rejects lost bindings, changed secrets, runtime, handlers or enabled sender',()=>{
  for(const mutate of [
    a=>a.resources.bindings.shift(),
    a=>a.resources.bindings[0].type='plain_text',
    a=>a.resources.bindings[1].text='changed',
    a=>a.resources.script_runtime.compatibility_date='2026-10-28',
    a=>a.resources.script.handlers.pop(),
    a=>a.resources.bindings.at(-1).text='true',
  ]){
    const before=baseline(), after=structuredClone(before);
    after.resources.bindings.push({name:'NESTWISE_DISPATCH_ENABLED',type:'plain_text',text:'false'});
    mutate(after);assert.throws(()=>verifyCandidate(before,after));
  }
});
test('release disables an existing sender and rejects ambiguous binding/deployment state',()=>{
  const before=baseline();before.resources.bindings.push({name:'NESTWISE_DISPATCH_ENABLED',type:'plain_text',text:'true'});
  assert.equal(releaseMetadata(before).bindings.at(-1).text,'false');
  before.resources.bindings.push(before.resources.bindings[0]);assert.throws(()=>releaseMetadata(before));
  assert.equal(soleVersion({versions:[{version_id:'current',percentage:100}]}),'current');
  assert.throws(()=>soleVersion({versions:[{version_id:'current',percentage:50}]}));
  assert.throws(()=>soleVersion({versions:[{version_id:'a',percentage:50},{version_id:'b',percentage:50}]}));
});
