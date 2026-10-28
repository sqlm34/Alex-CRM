// Inert code release only. This command cannot create keys or enable delivery.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const sorted = values => [...values].sort((a,b)=>a.name.localeCompare(b.name));
const secretTypes = ['secret_text','secret_key'];
const disabled = {name:'NESTWISE_DISPATCH_ENABLED',type:'plain_text',text:'false'};
export function releaseMetadata(before) {
  const bindings=before.resources.bindings;
  assert.equal(new Set(bindings.map(b=>b.name)).size,bindings.length,'Duplicate binding names');
  const old=bindings.find(b=>b.name===disabled.name);
  assert.ok(!old || old.type==='plain_text','Unexpected dispatch binding type');
  return {...before.resources.script_runtime,main_module:'index.js',
    bindings:[...bindings.filter(b=>b.name!==disabled.name&&!secretTypes.includes(b.type)),disabled],
    keep_bindings:secretTypes,
    annotations:{'workers/message':'Nestwise inert producer; preserve live CRM configuration; delivery disabled'}};
}
export function verifyCandidate(before,after) {
  assert.deepEqual(sorted(after.resources.bindings.filter(b=>b.name!==disabled.name)),
    sorted(before.resources.bindings.filter(b=>b.name!==disabled.name)),'Unrelated CRM bindings changed');
  assert.deepEqual(after.resources.bindings.filter(b=>b.name===disabled.name),[disabled],'Delivery is not disabled');
  assert.deepEqual(after.resources.script_runtime,before.resources.script_runtime,'Runtime changed');
  assert.deepEqual(after.resources.script.handlers,before.resources.script.handlers,'Worker handlers changed');
}
export function soleVersion(deployment) {
  const versions=deployment.versions;
  assert.equal(versions.length,1,'Split deployment requires review');
  assert.equal(versions[0].percentage,100,'Split deployment requires review');
  return versions[0].version_id;
}

async function main() {
  const args=process.argv.slice(2);
  assert.ok(args.length===3 || (args.length===4&&args[3]==='--apply'),
    'Usage: node scripts/nestwise-production-release.mjs EXPECTED_VERSION BUNDLE EXPECTED_SHA256 [--apply]');
  const [expected,bundlePath,expectedHash]=args;
  assert.match(expected,/^[a-f0-9-]{36}$/);
  assert.match(expectedHash,/^[a-f0-9]{64}$/);
  const bundle=await readFile(bundlePath);
  assert.equal(createHash('sha256').update(bundle).digest('hex'),expectedHash,'Bundle changed');
  for(const marker of ['NESTWISE_DISPATCH_ENABLED','MCP_ENABLED','MCP_WRITES_ENABLED'])
    assert.ok(bundle.includes(marker),'Missing integration in bundle: '+marker);
  const config=await readFile(join(process.env.APPDATA,'xdg.config/.wrangler/config/default.toml'),'utf8');
  const token=/^oauth_token\s*=\s*"([^"\r\n]+)"/m.exec(config)?.[1];
  assert.ok(token,'Wrangler authentication required');
  const base='https://api.cloudflare.com/client/v4/accounts/e33cd20566f035890048d7a17b42b410/workers/scripts/alex-crm-api';
  async function api(path,method='GET',body) {
    const headers={Authorization:'Bearer '+token};
    if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method,headers,body,signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    assert.ok(response.ok&&data.success,`Cloudflare ${method} ${path} rejected (${response.status}); inspect account separately`);
    return data.result;
  }
  const active=async()=>soleVersion((await api('/deployments')).deployments[0]);
  assert.equal(await active(),expected,'Active release changed');
  const before=await api('/versions/'+expected);
  const metadata=releaseMetadata(before);
  console.log(JSON.stringify({mode:args.includes('--apply')?'apply':'preflight',worker:'alex-crm-api',
    expectedVersion:expected,bundleSha256:expectedHash,preservedBindings:before.resources.bindings.length,
    dispatchEnabled:false,createsCredentials:false}));
  if(!args.includes('--apply'))return;
  // keep_bindings uses the latest version's secrets. Reject unpublished versions
  // so that an unrelated secret update cannot silently replace active secrets.
  assert.equal((await api('/versions')).items[0].id,expected,'Unpublished Worker version requires review');
  const form=new FormData();
  form.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
  form.set('index.js',new Blob([bundle],{type:'application/javascript+module'}),'index.js');
  const uploaded=await api('/versions','POST',form);
  verifyCandidate(before,await api('/versions/'+uploaded.id));
  assert.equal(await active(),expected,'Concurrent deployment; candidate not activated');
  await api('/deployments','POST',JSON.stringify({strategy:'percentage',versions:[{version_id:uploaded.id,percentage:100}]}));
  assert.equal(await active(),uploaded.id,'Activation verification failed');
  console.log(JSON.stringify({activeVersion:uploaded.id,rollbackVersion:expected,dispatchEnabled:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
