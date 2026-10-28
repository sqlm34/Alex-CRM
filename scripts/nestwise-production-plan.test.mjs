import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productionPlan} from './nestwise-production-plan.mjs';
import {dispatchAllowed} from '../worker/nestwise-delivery.mjs';

test('production plan is inert, preserves migration order and binds only the approved destination',async()=>{
  const plan=await productionPlan('2026-10-27T16:00:00.000Z','production-20261027');
  assert.equal(plan.vars.NESTWISE_DISPATCH_ENABLED,'false');
  assert.equal(dispatchAllowed(plan.vars),false);
  assert.equal(plan.vars.NESTWISE_DISPATCH_EXPIRES_AT,'2026-11-26T16:00:00.000Z');
  assert.deepEqual(plan.serviceBinding,{binding:'NESTWISE_RECEIVER',service:'nestwise-production'});
  assert.equal(plan.migrations.length,4);
  assert.match(plan.migrations[0].path,/_outbox.sql$/);
  assert.match(plan.migrations[1].path,/_review.sql$/);
  assert.match(plan.migrations[2].path,/_cost_corrections.sql$/);
  assert.match(plan.migrations[3].path,/_lifecycle.sql$/);
  for(const migration of plan.migrations)assert.match(migration.sha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(plan.vars,'NESTWISE_SIGNING_SECRET'),false);
  assert.equal(Object.hasOwn(plan,'DATABASE_URL'),false);
});
test('production plan rejects ambiguous dates and unsafe key labels',async()=>{
  for(const date of ['tomorrow','2026-10-27','2026-10-27T16:00:00Z','2026-10-27T16:00:00.000-04:00'])
    await assert.rejects(productionPlan(date,'key'));
  for(const key of ['',undefined,'key/other','key\nsecret','a'.repeat(65)])
    await assert.rejects(productionPlan('2026-10-27T16:00:00.000Z',key));
});
