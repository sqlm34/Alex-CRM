import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../worker/receptionist/test-entry.ts', import.meta.url), 'utf8')
function entry() {
  const calls = []
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', output)(() => ({ __esModule: true, default: { fetch: async (...args) => { calls.push(args); return Response.json({ ok: true }) } } }), module, module.exports)
  return { handler: module.exports.default, calls }
}
test('test deployment has a distinct Worker and no production bindings', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.receptionist-test.json', import.meta.url), 'utf8'))
  assert.equal(config.name, 'alex-crm-receptionist-test')
  assert.equal(config.vars.AI_RECEPTIONIST_ENABLED, 'false')
  for (const key of ['routes', 'triggers', 'r2_buckets', 'services']) assert.equal(config[key], undefined)
})
test('production DATABASE_URL alone cannot activate test routes', async () => {
  const { handler, calls } = entry()
  const response = await handler.fetch(new Request('https://test.example/api/receptionist/settings'), { DATABASE_URL: 'production', AI_RECEPTIONIST_DEPLOYMENT: 'preview' }, {})
  assert.equal(response.status, 503)
  assert.equal(calls.length, 0)
})
test('test entry blocks unrelated CRM routes', async () => {
  const { handler, calls } = entry()
  for (const path of ['/api/jobs', '/api/bookings', '/api/payments', '/api/attachments']) {
    assert.equal((await handler.fetch(new Request(`https://test.example${path}`), {}, {})).status, 404)
  }
  assert.equal(calls.length, 0)
  assert.equal(handler.scheduled, undefined)
})
test('test entry uses only isolated DB and forces notifications off', async () => {
  const { handler, calls } = entry()
  await handler.fetch(new Request('https://test.example/api/receptionist/settings'), {
    DATABASE_URL: 'production', RECEPTIONIST_TEST_DATABASE_URL: 'isolated', AI_RECEPTIONIST_DEPLOYMENT: 'preview',
    AI_RECEPTIONIST_PUSH_ENABLED: 'true', CUSTOMER_BOOKING_EMAIL_ENABLED: 'true',
  }, {})
  assert.equal(calls[0][1].DATABASE_URL, 'isolated')
  assert.equal(calls[0][1].AI_RECEPTIONIST_PUSH_ENABLED, 'false')
  assert.equal(calls[0][1].CUSTOMER_BOOKING_EMAIL_ENABLED, 'false')
})
