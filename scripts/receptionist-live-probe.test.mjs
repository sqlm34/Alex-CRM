import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const source = readFileSync(new URL('../worker/receptionist/live-probe.ts', import.meta.url), 'utf8')
function fixture() {
  const module = { exports: {} }, queries = []
  let google = 0, rolledBack = false
  const client = { release() {}, async query(text) {
    queries.push(text)
    if (text === 'rollback') rolledBack = true
    if (text.startsWith('select job_text')) return { rows: [{ job_text: '', details: '' }] }
    if (text.startsWith('select count')) return { rows: [{ n: 1 }] }
    if (text.startsWith('select (select count')) return { rows: [{ jobs: rolledBack ? 0 : 1, calls: 0, notifications: 0 }] }
    return { rows: [] }
  } }
  let bookings = 0
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', output)(name => {
    if (name === '@neondatabase/serverless') return { Pool: class { async connect() { return client } async end() {} } }
    if (name === './test-entry') return { __esModule: true, default: { fetch: async () => new Response('normal') } }
    if (name === './booking') return { bookingInput: input => input, verifyBookingAddress: async () => { google++; return { lat: 39.9, lng: -86.1 } },
      persistPhoneBooking: async () => ({ confirmed: true, jobId: 'synthetic', replay: bookings++ > 0 }) }
    throw Error('Unexpected import')
  }, module, module.exports)
  return { handler: module.exports.default, queries, google: () => google }
}
const token = '1'.repeat(64)
const env = { RECEPTIONIST_PROBE_HASH: createHash('sha256').update(token).digest('hex'), RECEPTIONIST_PROBE_EXPIRES: String(Date.now() + 300000),
  AI_RECEPTIONIST_DEPLOYMENT: 'preview', AI_RECEPTIONIST_GEOCODING_KEY: 'fake',
  RECEPTIONIST_TEST_DATABASE_URL: 'postgres://user:fake@ep-shiny-wildflower-b4370jck-pooler.c-6.us-east-2.aws.neon.tech/neondb' }
const request = (authorization = `Bearer ${token}`) => new Request('https://test.example/_receptionist-live-probe', { method: 'POST', headers: { authorization } })

test('probe rejects unauthenticated and expired requests before paid requests or database access', async () => {
  const f = fixture()
  assert.equal((await f.handler.fetch(request(''), env, {})).status, 403)
  assert.equal((await f.handler.fetch(request(`Bearer ${'2'.repeat(64)}`), env, {})).status, 403)
  assert.equal((await f.handler.fetch(request(), { ...env, RECEPTIONIST_PROBE_EXPIRES: '0' }, {})).status, 404)
  assert.equal(f.queries.length, 0); assert.equal(f.google(), 0)
})
test('probe cannot use production or another database', async () => {
  const f = fixture()
  assert.equal((await f.handler.fetch(request(), { ...env, AI_RECEPTIONIST_DEPLOYMENT: 'production' }, {})).status, 404)
  assert.equal((await f.handler.fetch(request(), { ...env, RECEPTIONIST_TEST_DATABASE_URL: 'postgres://localhost/production' }, {})).status, 409)
  assert.equal(f.queries.length, 0); assert.equal(f.google(), 0)
})
test('probe verifies address once, rolls back booking and verifies absence afterward', async () => {
  const f = fixture()
  const response = await f.handler.fetch(request(), env, {})
  assert.equal(response.status, 200)
  assert.equal((await response.json()).rollbackVerified, true)
  assert.equal(f.google(), 1)
  assert.equal(f.queries.filter(q => q === 'commit').length, 1)
  assert.ok(f.queries.includes('rollback'))
})
test('normal deployment has no probe import or route', () => {
  const entry = readFileSync(new URL('../worker/receptionist/test-entry.ts', import.meta.url), 'utf8')
  assert.ok(!entry.includes('live-probe'))
  assert.ok(!entry.includes('RECEPTIONIST_PROBE'))
})
