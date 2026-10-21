import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validateStagingConfig} from './nestwise-staging-preflight.mjs';

// Generates configuration only; no credentials, deployment or database writes.
export function canaryPlan(base, start) {
  validateStagingConfig(base);
  const time=Date.parse(start);
  assert.ok(Number.isFinite(time),'Explicit valid start time required');
  return {...base,vars:{...base.vars,
    NESTWISE_DISPATCH_ENABLED:'true',
    NESTWISE_ENDPOINT:'https://nestwise-staging.alexeasyrepair.workers.dev/v1/crm/events',
    NESTWISE_CONNECTION:'crm-synthetic-canary',
    NESTWISE_KEY_ID:'crm-synthetic-canary',
    NESTWISE_DISPATCH_NOT_BEFORE:new Date(time).toISOString(),
    NESTWISE_DISPATCH_EXPIRES_AT:new Date(time+3600000).toISOString(),
  }};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  assert.equal(process.argv.length,3,'Usage: node scripts/nestwise-canary-plan.mjs <ISO start>');
  const base=JSON.parse(await readFile(new URL('../wrangler.nestwise-staging.json',import.meta.url),'utf8'));
  console.log(JSON.stringify(canaryPlan(base,process.argv[2]),null,2));
}
