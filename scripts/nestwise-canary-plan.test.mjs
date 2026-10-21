import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canaryPlan} from './nestwise-canary-plan.mjs';
import {dispatchWindowOpen} from '../worker/nestwise-delivery.mjs';
const base=JSON.parse(await readFile(new URL('../wrangler.nestwise-staging.json',import.meta.url),'utf8'));
test('canary preserves isolation, expires after an hour and contains no secret',()=>{
  const result=canaryPlan(base,'2026-10-20T18:00:00Z');
  assert.equal(result.workers_dev,false);assert.equal(result.preview_urls,false);
  assert.equal(result.name,'alex-crm-nestwise-staging');
  assert.equal(result.triggers,undefined);assert.equal(result.routes,undefined);
  assert.equal(result.vars.NESTWISE_SIGNING_SECRET,undefined);
  assert.equal(result.vars.NESTWISE_DISPATCH_EXPIRES_AT,'2026-10-20T19:00:00.000Z');
  assert.equal(dispatchWindowOpen(result.vars,Date.parse('2026-10-20T18:30:00Z')),true);
  assert.equal(dispatchWindowOpen(result.vars,Date.parse('2026-10-20T19:00:00Z')),false);
  assert.equal(base.vars.NESTWISE_DISPATCH_ENABLED,'false');
});
test('canary cannot derive from a public or production target',()=>{
  for(const override of [{name:'alex-crm-api'},{workers_dev:true},{preview_urls:true},
    {triggers:{crons:['* * * * *']}},{vars:{...base.vars,NESTWISE_ENVIRONMENT:'production'}}])
    assert.throws(()=>canaryPlan({...base,...override},'2026-10-20T18:00:00Z'));
  assert.throws(()=>canaryPlan(base,'not-a-date'));
});
