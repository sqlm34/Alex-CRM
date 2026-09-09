import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const configText = read('../worker/googleActionsConfig.ts')
const moduleText = read('../worker/googleActions.ts')
const code = ts.transpileModule(configText + '\n' + moduleText.replace(/^import .*$/m, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const exports = {}
// Even accidental fetch use fails locally; no real Google requests in any test.
new Function('exports', 'fetch', code)(exports, () => { throw Error('External network forbidden') })
const { googleActionsConfig: config, validateGoogleAttribution: validate, attributionLifetimeMs: ttl,
  captureGoogleAttribution: capture, enqueueGoogleConversion: enqueue, processGoogleConversions: processQueue,
  googleConversionOutcome: outcome, safelyEnqueueGoogleConversion: safeEnqueue } = exports
const env = { GOOGLE_ACTIONS_CENTER_ENABLED: 'true', GOOGLE_ACTIONS_CENTER_ENV: 'sandbox',
  GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: 'test', GOOGLE_ACTIONS_CENTER_PARTNER_ID: '123456789',
  GOOGLE_ACTIONS_CENTER_MERCHANT_ID: 'synthetic-merchant' }
const input = () => ({ rwg_token: 'synthetic+/token==', captured_at: Date.now() - 1000 })

test('exact enabled and independent production deployment gates; missing config fails closed', async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1', true]) {
    const disabled = { ...env, GOOGLE_ACTIONS_CENTER_ENABLED: flag }
    assert.equal(config(disabled), null)
    await processQueue({ query: () => assert.fail('No DB when disabled') }, disabled, () => assert.fail('No HTTP'))
  }
  for (const key of ['GOOGLE_ACTIONS_CENTER_ENV', 'GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV', 'GOOGLE_ACTIONS_CENTER_PARTNER_ID', 'GOOGLE_ACTIONS_CENTER_MERCHANT_ID']) {
    assert.equal(config({ ...env, [key]: '' }), null)
  }
  const production = { ...env, GOOGLE_ACTIONS_CENTER_ENV: 'production', GOOGLE_ACTIONS_CENTER_PRODUCTION_ENABLED: 'true' }
  for (const deployment of ['local', 'test', 'preview', 'sandbox', undefined]) assert.equal(config({ ...production, GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: deployment }), null)
  assert.equal(config({ ...production, GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: 'production' }).environment, 'production')
  assert.equal(config({ ...env, GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: 'production' }), null)
  for (const partner of ['TODO_FROM_GOOGLE', '<123>', 'partner', '1x']) assert.equal(config({ ...env, GOOGLE_ACTIONS_CENTER_PARTNER_ID: partner }), null)
  for (const merchant of ['TODO_FROM_GOOGLE', 'REPLACE_ME', 'x'.repeat(101), 'bad merchant']) assert.equal(config({ ...env, GOOGLE_ACTIONS_CENTER_MERCHANT_ID: merchant }), null)
})

test('capture limiter bounds per-IP attempts and total in-memory keys', () => {
  const now = Date.now() + 60000
  for (let i = 0; i < 20; i++) assert.equal(exports.allowGoogleCapture('synthetic', now), true)
  assert.equal(exports.allowGoogleCapture('synthetic', now), false)
  for (let i = 0; i < 4095; i++) assert.equal(exports.allowGoogleCapture(`synthetic-${i}`, now), true)
  assert.equal(exports.allowGoogleCapture('overflow', now), false)
  assert.equal(exports.allowGoogleCapture('synthetic', now + 60001), true)
})

test('30-day clock, merchant allowlist, full decoded token and invalid input validation', () => {
  const now = Date.now(), c = config(env), good = input()
  assert.equal(validate(good, c, now).token, good.rwg_token)
  assert.equal(validate({ ...good, captured_at: now - ttl + 1 }, c, now).expiresAt, now + 1)
  for (const captured_at of [now + 1, now - ttl, 0, '123', Infinity]) assert.equal(validate({ ...good, captured_at }, c, now), null)
  for (const rwg_token of ['', 'bad\nvalue', '\ufffd', 'a'.repeat(16385), null, {}]) assert.equal(validate({ ...good, rwg_token }, c, now), null)
  assert.equal(validate({ ...good, merchant_id: 'unknown' }, c, now), null)
  assert.equal(validate({ ...good, rwg_token: 'x'.repeat(16384) }, c, now).token.length, 16384)
})

test('only explicit rate limiting retries; timeout/5xx are honest ambiguous states', () => {
  assert.equal(outcome(200, 1).status, 'sent')
  assert.equal(outcome(204, 1).status, 'sent')
  for (const status of [400, 401, 403, 302]) assert.equal(outcome(status, 1).status, 'failed_terminal')
  for (const status of [null, 408, 500, 503]) assert.equal(outcome(status, 1).status, 'ambiguous')
  assert.equal(outcome(429, 4).status, 'pending')
  assert.equal(outcome(429, 5).status, 'failed_terminal')
})

test('enqueue failure is isolated and missing token never reaches DB', async () => {
  assert.equal(await safeEnqueue({ query: () => { throw Error('sensitive SQL error') } }, env, crypto.randomUUID(), 's', 'j'), false)
  assert.equal(await enqueue({ query: () => assert.fail('missing handle') }, env, undefined, 's', 'j'), false)
})

test('slow capture body is canceled within a bounded read deadline', async () => {
  let canceled = false
  const stream = new ReadableStream({ cancel() { canceled = true } })
  const result = await exports.readGoogleCaptureBody(new Request('https://isolated.invalid', { method: 'POST', body: stream, duplex: 'half' }))
  assert.equal(result.status, 408)
  assert.equal(canceled, true)
})

test('privacy and integration: protected table only, no token joins in jobs API, source detail is server assigned', () => {
  const worker = read('../worker/index.ts')
  assert.doesNotMatch(worker, /join google_actions_attributions/i)
  assert.doesNotMatch(moduleText, /console\.|response\.text\(|response\.json\(/)
  assert.match(moduleText, /returning id as attribution_id, captured_at, expires_at/)
  assert.match(worker, /safelyEnqueueGoogleConversion\(sql, env, payload.google_actions_attribution_id, session.id, savedJob.id\)/)
  assert.match(worker, /jobs.booking_source_detail/)
  assert.doesNotMatch(moduleText, /select \*/i)
})

test('actual Worker capture route: disabled, forbidden origin, bounded body, opaque response, sanitized failures', async () => {
  const worker = read('../worker/index.ts')
  const ast = ts.createSourceFile('worker.ts', worker, ts.ScriptTarget.Latest, true)
  const assignment = ast.statements.find(ts.isExportAssignment)
  const js = ts.transpileModule(assignment.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const workerExports = {}
  let captures = 0, dbCalls = 0, fail = false
  new Function('exports', 'googleActionsConfig', 'getSql', 'captureGoogleAttribution', 'json', 'allowGoogleCapture', 'readGoogleCaptureBody', js)(
    workerExports, config, () => { dbCalls++; return {} }, async () => {
      captures++
      if (fail) throw Error('sensitive raw token and SQL')
      return { attribution_id: 'opaque', captured_at: new Date('2026-09-09T00:00:00Z'), expires_at: new Date('2026-10-09T00:00:00Z') }
    }, (body, _request, _env, status = 200) => Response.json(body, { status }), exports.allowGoogleCapture, exports.readGoogleCaptureBody,
  )
  const route = workerExports.default.fetch
  const request = (body, origin = 'https://booking.example.test') => new Request('https://api.example.test/api/public/booking/google-actions/attribution', {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body),
  })
  const settings = { ...env, ALLOWED_ORIGIN: 'https://booking.example.test' }
  assert.equal((await route(request(input()), {}, {})).status, 200)
  assert.equal(captures, 0)
  assert.equal(dbCalls, 0)
  assert.equal((await route(request(input(), 'https://evil.example.test'), settings, {})).status, 403)
  assert.equal((await route(request(input(), ''), settings, {})).status, 403)
  assert.equal((await route(request({ rwg_token: 'x'.repeat(131073) }), settings, {})).status, 413)
  assert.equal(captures, 0)
  const response = await route(request(input()), settings, {})
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { attribution_id: 'opaque', captured_at: '2026-09-09T00:00:00.000Z', expires_at: '2026-10-09T00:00:00.000Z' })
  fail = true
  const failed = await route(request(input()), settings, {})
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: 'Attribution unavailable' })
})

const testPort = Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 0)
if (testPort && (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535)) throw Error('Invalid local-only test port')

test('isolated PostgreSQL: capture dedupe, outbox locking, retry, environment isolation and privacy', { skip: !testPort }, async () => {
  // Dedicated loopback credentials only; never read DATABASE_URL or any application secrets.
  const schema = 'google_actions_test_' + crypto.randomUUID().replaceAll('-', '')
  const pool = new pg.Pool({ host: '127.0.0.1', port: testPort, user: 'webhook_test',
    password: 'local-test-only', database: 'webhook_test', max: 8, options: `-c search_path=${schema} -c timezone=America/Indiana/Indianapolis` })
  const sql = { query: async (text, values) => (await pool.query(text, values)).rows }
  let createdSchema = false
  try {
    assert.deepEqual((await sql.query('select current_database() as db, current_user as username'))[0],
      { db: 'webhook_test', username: 'webhook_test' })
    await sql.query(`create schema ${schema}`)
    createdSchema = true
    await sql.query('create table if not exists jobs(id text primary key, booking_source text); create table if not exists booking_sessions(id text primary key, job_id text)')
    await sql.query(read('../migrations/2026-09-09_add_google_actions_center.sql').replaceAll('public.', `${schema}.`))
    await sql.query(read('../migrations/2026-09-09_add_google_actions_center.sql').replaceAll('public.', `${schema}.`))
    const data = input()
    const first = await capture(sql, env, data)
    const second = await capture(sql, env, { ...data, captured_at: data.captured_at + 500 })
    assert.equal(first.attribution_id, second.attribution_id)
    assert.equal(new Date(first.expires_at).getTime(), data.captured_at + ttl)
    assert.equal(new Date(second.expires_at).getTime(), data.captured_at + ttl)
    // A March capture crosses DST in Indiana; expiry must be exactly 720 hours.
    await sql.query(`insert into google_actions_attributions
      (id,capture_key,environment,deployment,partner_id,merchant_id,captured_at,expires_at)
      values ('dst','dst','sandbox','test','123456789','synthetic-merchant',
      '2026-03-01T12:00:00Z'::timestamptz,'2026-03-31T12:00:00Z'::timestamptz)`)
    assert.deepEqual(Object.keys(first).sort(), ['attribution_id', 'captured_at', 'expires_at'])
    const seed = async (id, attribution = first.attribution_id, settings = env) => {
      await sql.query('insert into jobs(id) values ($1);', [id])
      await sql.query('insert into booking_sessions(id,job_id) values ($1,$1)', [id])
      return enqueue(sql, settings, attribution, id, id)
    }
    assert.equal(await seed('success'), true)
    assert.equal(await enqueue(sql, env, first.attribution_id, 'success', 'success'), false)
    assert.equal(await seed('wrong-env', first.attribution_id, { ...env, GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: 'preview' }), false)
    let requests = 0
    const send = async (url, options) => {
      requests++
      assert.equal(url, 'https://www.google.com/maps/conversion/debug/collect')
      assert.equal(options.headers['Content-Type'], 'text/plain')
      assert.equal(options.redirect, 'error')
      assert.deepEqual(JSON.parse(options.body), { conversion_partner_id: '123456789', rwg_token: data.rwg_token, merchant_changed: '2' })
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(null, { status: 204 })
    }
    await Promise.all([processQueue(sql, env, send), processQueue(sql, env, send)])
    await processQueue(sql, env, send)
    assert.equal(requests, 1)
    assert.equal((await sql.query("select status from google_actions_conversions where job_id='success'"))[0].status, 'sent')
    assert.deepEqual((await sql.query("select booking_source,booking_source_detail from jobs where id='success'"))[0], { booking_source: 'google', booking_source_detail: 'actions_center' })
    for (const status of [400, 401, 403, 429, 500, null]) {
      const id = `case-${status}`
      await seed(id)
      await processQueue(sql, env, async () => { if (status === null) throw Error('timeout with token'); return new Response(null, { status }) })
      const row = (await sql.query('select status, attempts, last_error from google_actions_conversions where job_id=$1', [id]))[0]
      assert.equal(row.status, outcome(status, 1).status)
      assert.equal(row.attempts, 1)
      if (status === 429) {
        for (let attempt = 2; attempt <= 5; attempt++) {
          await sql.query('update google_actions_conversions set next_attempt_at=now() where job_id=$1', [id])
          await processQueue(sql, env, async () => new Response(null, { status: 429 }))
        }
        assert.equal((await sql.query('select status from google_actions_conversions where job_id=$1', [id]))[0].status, 'failed_terminal')
      }
    }
    await seed('crashed')
    await sql.query("update google_actions_conversions set status='sending',attempts=1,lease_until=now()-interval '1 minute' where job_id='crashed'")
    await processQueue(sql, env, () => assert.fail('Stale sends must not be replayed'))
    assert.equal((await sql.query("select status from google_actions_conversions where job_id='crashed'"))[0].status, 'ambiguous')
    await seed('expired')
    await sql.query("update google_actions_attributions set captured_at=now()-interval '744 hours',expires_at=now()-interval '24 hours'")
    await processQueue(sql, env, () => assert.fail('Expired token cannot send'))
    assert.equal((await sql.query('select count(*)::int as n from google_actions_attributions where rwg_token is not null'))[0].n, 0)
    assert.equal((await sql.query("select status from google_actions_conversions where job_id='expired'"))[0].status, 'failed_terminal')
    assert.equal(await capture(sql, env, { ...data, captured_at: Date.now() - 1 }), null)
  } finally {
    try { if (createdSchema) await sql.query(`drop schema ${schema} cascade`) } finally { await pool.end() }
  }
})
