import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Deliberately narrow initial provisioning profile. A later activation requires
// a reviewed change, not CLI overrides or inheritance from the live Worker.
export function validateStagingConfig(config) {
  const allowedKeys=['$schema','name','main','compatibility_date','compatibility_flags','workers_dev','preview_urls','vars'];
  assert.ok(Object.keys(config).every(key=>allowedKeys.includes(key)), 'Unexpected binding, route, cron or environment override');
  assert.equal(config.name,'alex-crm-nestwise-staging','Must target the separate CRM Worker');
  assert.equal(config.main,'worker/index.ts');
  assert.equal(config.workers_dev,false,'Initial provisioning must not expose a public endpoint');
  assert.equal(config.preview_urls,false,'Preview URLs must remain disabled');
  assert.deepEqual(config.compatibility_flags,['nodejs_compat']);
  const expected={
    NESTWISE_ENVIRONMENT:'staging',NESTWISE_DISPATCH_ENABLED:'false',
    GOOGLE_ACTIONS_CENTER_ENABLED:'false',GOOGLE_ACTIONS_CENTER_ENV:'sandbox',
    GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV:'preview',GOOGLE_ACTIONS_CENTER_PRODUCTION_ENABLED:'false',
    ALLOWED_ORIGIN:'https://nestwise-staging.alexeasyrepair.workers.dev',
    ATTACHMENTS_R2_ENABLED:'false',STRIPE_PAYMENT_ATTEMPTS_ENABLED:'false',
    STRIPE_WEBHOOK_ENABLED:'false',PARTS_PUBLIC_CATALOG_ENABLED:'false',
  };
  assert.deepEqual(config.vars,expected,'Only explicit inert staging variables are allowed; never plaintext secrets');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv.length,2,'No target overrides accepted');
  const config=JSON.parse(await readFile(new URL('../wrangler.nestwise-staging.json',import.meta.url),'utf8'));
  validateStagingConfig(config);
  console.log('Separate CRM staging profile verified: no public URL, routes, cron, resource bindings or dispatch. Remote secrets and database identity still require provisioning checks.');
}
