import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateStagingConfig} from './nestwise-staging-preflight.mjs';

const config=JSON.parse(await readFile(new URL('../wrangler.nestwise-staging.json',import.meta.url),'utf8'));
test('isolated provisioning profile is inert',()=>assert.equal(validateStagingConfig(config),true));
test('rejects targeting the current CRM preview Worker',async()=>{
  const preview=JSON.parse(await readFile(new URL('../wrangler.preview.json',import.meta.url),'utf8'));
  assert.throws(()=>validateStagingConfig(preview));
});
for(const [name,patch] of Object.entries({
  'production target':{name:'alex-crm-api'},
  'public URL':{workers_dev:true},
  'preview URL':{preview_urls:true},
  'route':{routes:['crm.example.com/*']},
  'cron':{triggers:{crons:['*/5 * * * *']}},
  'live bucket':{r2_buckets:[{binding:'ATTACHMENTS_BUCKET',bucket_name:'alex-crm-attachments-production'}]},
  'environment override':{env:{production:{name:'alex-crm-api'}}},
  'dispatch':{vars:{...config.vars,NESTWISE_DISPATCH_ENABLED:'true'}},
  'plaintext secret':{vars:{...config.vars,DATABASE_URL:'synthetic-secret'}},
  'wildcard CORS':{vars:{...config.vars,ALLOWED_ORIGIN:'*'}},
  'Stripe enablement':{vars:{...config.vars,STRIPE_WEBHOOK_ENABLED:'true'}},
}))test(`rejects ${name}`,()=>assert.throws(()=>validateStagingConfig({...structuredClone(config),...patch})));
