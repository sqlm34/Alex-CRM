import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const config = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))

test('production and preview explicitly override inherited Stripe gates', () => {
  const production = config('wrangler.json')
  const preview = config('wrangler.preview.json')
  for (const gate of ['STRIPE_PAYMENT_ATTEMPTS_ENABLED', 'STRIPE_WEBHOOK_ENABLED']) {
    assert.equal(production.vars[gate], 'true')
    assert.equal(preview.vars[gate], 'false')
  }
  assert.equal(production.name, 'alex-crm-api')
  assert.equal(preview.name, production.name)
  assert.equal(preview.main, production.main)
  assert.equal(production.vars.ATTACHMENTS_R2_ENABLED, 'true')
  assert.deepEqual(production.r2_buckets, [{ binding: 'ATTACHMENTS_BUCKET', bucket_name: 'alex-crm-attachments-production' }])
  assert.equal(preview.vars.ATTACHMENTS_R2_ENABLED, 'false')
  assert.equal(preview.r2_buckets, undefined)
  for (const current of [production, preview]) {
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'R2_SECRET_ACCESS_KEY']) {
      assert.equal(current.vars[name], undefined)
    }
  }
})
