import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function load(relative) {
  const path = resolve(root, relative)
  if (cache.has(path)) return cache.get(path)
  const module = { exports: {} }
  cache.set(path, module.exports)
  const require = createRequire(path)
  new Function('require', 'exports', 'module', ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(name => name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : require(name), module.exports, module)
  return module.exports
}
const domain = load('shared/receptionist.ts')
const retell = load('worker/receptionist/retell.ts')
const booking = load('worker/receptionist/booking.ts')
const { processReceptionistPush, checkReceptionistPush } = load('worker/receptionist/notifications.ts')
const config = load('worker/receptionist/retell-config.ts')
const { receptionistRoute, bookingEnabled } = load('worker/receptionist/routes.ts')
const settings = { ...domain.defaultReceptionistSettings, enabled: true, serviceZips: ['46032'], publicPhone: '+13175550142', transferPhone: '+13175550143' }
const service = { appliance: 'Washer repair', issue: 'Not draining', diagnosis: 'unknown', requestedService: 'diagnostic' }
const input = { customer: 'Synthetic Customer', phone: '+13175550142', address: '123 Synthetic Street, Carmel, IN', zip: '46032', service, date: '2026-11-02', window: '9:00 AM - 11:00 AM', confirmed: true }
const call = { call_id: 'call_test', agent_id: 'agent_test', to_number: '+13175550140', from_number: '+13175550142', direction: 'inbound', call_type: 'phone_call', call_status: 'ongoing' }
const env = { AI_RECEPTIONIST_ENABLED: 'true', RETELL_API_KEY: 'synthetic-test-secret', RETELL_WEBHOOK_API_KEY: 'synthetic-test-secret', RETELL_AGENT_ID: call.agent_id, RETELL_TEST_PHONE: call.to_number }
async function sign(raw, secret = env.RETELL_WEBHOOK_API_KEY, timestamp = Date.now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw + timestamp))
  return `v=${timestamp},d=${Buffer.from(digest).toString('hex')}`
}
test('defaults disable receptionist, recordings are not part of mutable settings', () => {
  assert.equal(domain.defaultReceptionistSettings.enabled, false)
  assert.throws(() => domain.validateReceptionistSettings({ ...settings, recordCalls: true }))
})
test('approved settings validate', () => assert.deepEqual(domain.validateReceptionistSettings(settings), settings))
test('callback-only operation accepts no transfer destination', () => {
  assert.equal(domain.validateReceptionistSettings({ ...settings, transferPhone: '' }).transferPhone, '')
  assert.ok(!domain.receptionistTools.some(name => /transfer/i.test(name)))
})
test('approved website coverage and owner fee are staged without enabling calls', () => {
  const staged = JSON.parse(readFileSync(resolve(root, 'worker/receptionist/approved-test-settings.json'), 'utf8'))
  assert.deepEqual(domain.validateReceptionistSettings(staged), staged)
  assert.equal(staged.enabled, false)
  assert.equal(staged.testMode, true)
  assert.equal(staged.transferPhone, '')
  assert.deepEqual(staged.serviceZips, ['46032', '46033', '46037', '46038', '46040', '46055', '46060', '46062', '46074', '46077'])
  assert.equal(staged.diagnosticFee, 'The diagnostic fee is $89. This fee is waived if you proceed with the repair.')
})
test('Retell tool configuration matches routes and cannot target production', () => {
  const tools = config.retellTestTools('https://alex-crm-receptionist-test.alexeasyrepair.workers.dev')
  assert.deepEqual(tools.map(tool => tool.name), [...domain.receptionistTools])
  for (const tool of tools) {
    assert.equal(tool.args_at_root, false)
    assert.equal(tool.max_retry, 0)
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties))
    assert.equal(tool.headers, undefined)
    assert.ok(tool.url.endsWith(`/tools/${tool.name}`))
  }
  assert.throws(() => config.retellTestTools('https://aleksappliancerepair.com'))
  assert.deepEqual(tools.find(tool => tool.name === 'createBooking').parameters.properties.confirmed.enum, [true])
})
for (const [name, change] of [
  ['missing coverage', { serviceZips: [] }], ['invalid ZIP', { serviceZips: ['*'] }], ['transfer loop', { transferPhone: settings.publicPhone }],
  ['missing public phone', { publicPhone: '' }], ['unknown appliance', { appliances: ['Boiler'] }], ['negative revision', { revision: -1 }],
  ['string switch', { enabled: 'true' }], ['arbitrary settings', { endpoint: 'https://example.com' }],
]) test(`settings reject ${name}`, () => assert.throws(() => domain.validateReceptionistSettings({ ...settings, ...change })))
for (const [value, normalized] of [['317-555-0142', '+13175550142'], ['(317) 555-0142', '+13175550142'], ['13175550142', '+13175550142']]) {
  test(`normalizes phone ${value}`, () => assert.equal(domain.phoneNumber(value), normalized))
}
for (const date of ['2026-02-30', '10/16/26', '2026-13-01', '']) test(`rejects invalid date ${date}`, () => assert.throws(() => domain.calendarDate(date)))
test('accepts leap day', () => assert.equal(domain.calendarDate('2028-02-29'), '2028-02-29'))
test('ordinary diagnostic eligible', () => assert.equal(domain.serviceEligibility(settings, service).eligible, true))
for (const requestedService of ['compressor', 'refrigerant', 'sealed_system']) test(`blocks ${requestedService}`, () => {
  assert.equal(domain.serviceEligibility(settings, { ...service, requestedService }).eligible, false)
})
test('blocks confirmed sealed system even if diagnostic allowed', () => assert.equal(domain.serviceEligibility({ ...settings, suspectedSealedSystemDiagnostic: true }, { ...service, diagnosis: 'confirmed_sealed_system' }).eligible, false))
test('freon mention requires clarification even when model says unknown', () => assert.equal(domain.serviceEligibility(settings, { ...service, issue: 'Needs freon' }).reason, 'clarify_sealed_system_diagnosis'))
test('suspected freon diagnostic requires explicit policy', () => {
  const request = { ...service, issue: 'Maybe low freon', diagnosis: 'suspected_sealed_system' }
  assert.equal(domain.serviceEligibility(settings, request).eligible, false)
  assert.equal(domain.serviceEligibility({ ...settings, suspectedSealedSystemDiagnostic: true }, request).eligible, true)
})
test('booking requires caller confirmation and rejects model coordinates', () => {
  assert.throws(() => booking.bookingInput({ ...input, confirmed: false }))
  assert.throws(() => booking.bookingInput({ ...input, lat: 39 }))
  assert.equal(booking.bookingInput(input).phone, '+13175550142')
})
test('production is never enabled by booking switch alone', () => {
  assert.equal(bookingEnabled({ ...env, AI_RECEPTIONIST_BOOKING_ENABLED: 'true', AI_RECEPTIONIST_DEPLOYMENT: 'production', AI_RECEPTIONIST_GEOCODING_KEY: 'synthetic' }), false)
  const testEnv = { ...env, AI_RECEPTIONIST_BOOKING_ENABLED: 'true', AI_RECEPTIONIST_DEPLOYMENT: 'preview', AI_RECEPTIONIST_GEOCODING_KEY: 'synthetic' }
  assert.equal(bookingEnabled(testEnv), false)
  assert.equal(bookingEnabled({ ...testEnv, AI_RECEPTIONIST_BOOKING_TEST_UNTIL: String(Date.now() + 1800000) }), true)
  assert.equal(bookingEnabled({ ...testEnv, AI_RECEPTIONIST_BOOKING_TEST_UNTIL: '0' }), false)
  assert.equal(bookingEnabled({ ...testEnv, AI_RECEPTIONIST_BOOKING_TEST_UNTIL: 'invalid' }), false)
  assert.equal(bookingEnabled({ ...testEnv, AI_RECEPTIONIST_BOOKING_TEST_UNTIL: String(Date.now() + 7200000) }), false)
})
test('Retell accepts valid signature and rejects modified body/key', async () => {
  const raw = '{"a":1}', signature = await sign(raw)
  assert.equal(await retell.verifyRetell(raw, signature, env.RETELL_API_KEY), true)
  assert.equal(await retell.verifyRetell('{"a":2}', signature, env.RETELL_API_KEY), false)
  assert.equal(await retell.verifyRetell(raw, signature, 'other-secret'), false)
})
for (const delta of [-300001, 300001]) test(`rejects timestamp ${delta}`, async () => {
  const now = Date.now(), signature = await sign('{}', env.RETELL_API_KEY, now + delta)
  assert.equal(await retell.verifyRetell('{}', signature, env.RETELL_API_KEY, now), false)
})
for (const signature of ['', 'v=NaN,d=ab', 'v=1,d=00', 'v=1,d=' + 'z'.repeat(64)]) test(`rejects malformed signature ${signature.slice(0, 12)}`, async () => assert.equal(await retell.verifyRetell('{}', signature, env.RETELL_API_KEY), false))
for (const patch of [{ agent_id: 'other' }, { to_number: '+13175550149' }, { direction: 'outbound' }, { call_type: 'web_call' }, { call_id: '../x' }]) test(`rejects foreign call ${JSON.stringify(patch)}`, () => assert.throws(() => retell.retellCall({ ...call, ...patch }, env.RETELL_AGENT_ID, env.RETELL_TEST_PHONE)))
test('body size checked on stream, not just Content-Length', async () => {
  await assert.rejects(retell.limitedBody(new Request('https://example.com', { method: 'POST', body: '123456' }), 5), /Payload too large/)
})
const geo = { status: 'OK', results: [{ types: ['street_address'], address_components: [
  { types: ['postal_code'], short_name: '46032' }, { types: ['country'], short_name: 'US' }, { types: ['street_number'], short_name: '123' }, { types: ['route'], short_name: 'Synthetic St' },
], geometry: { location: { lat: 39.9, lng: -86.1 } } }] }
test('uses only verified geocoder coordinates', () => assert.deepEqual(booking.geocodeLocation(geo, '46032'), { lat: 39.9, lng: -86.1 }))
test('rejects mismatched ZIP, partial and ambiguous geocoding', () => {
  assert.throws(() => booking.geocodeLocation(geo, '46201'))
  assert.throws(() => booking.geocodeLocation({ ...geo, results: [{ ...geo.results[0], partial_match: true }] }, '46032'))
  assert.throws(() => booking.geocodeLocation({ ...geo, results: [...geo.results, ...geo.results] }, '46032'))
})
test('no geocoding key fails closed without network request', async () => await assert.rejects(booking.verifyBookingAddress(booking.bookingInput(input), ''), /unavailable/))

test('Retell metrics whitelist preserves zero and fractional cents without transcripts', () => {
  const now = Date.now()
  assert.deepEqual(retell.retellMetrics({ start_timestamp: now - 10000, end_timestamp: now,
    call_cost: { combined_cost: 15.5 }, latency: { e2e: { p50: 0 } }, transcript: 'PRIVATE', recording_url: 'PRIVATE' }, now), {
    startedAt: new Date(now - 10000).toISOString(), endedAt: new Date(now).toISOString(), costCents: 15.5, latencyMs: 0,
  })
  assert.deepEqual(retell.retellMetrics({ call_cost: { combined_cost: '0' }, latency: { e2e: { p50: -1 } } }), {
    startedAt: null, endedAt: null, costCents: null, latencyMs: null,
  })
  assert.equal(retell.retellMetrics({ start_timestamp: now, end_timestamp: now - 1 }).endedAt, null)
  assert.equal(retell.retellMetrics({ call_cost: { combined_cost: Infinity } }).costCents, null)
})
async function route(tool, args = {}, options = {}) {
  const raw = JSON.stringify({ call, args })
  const request = new Request(`https://example.com/api/receptionist/providers/retell/tools/${tool}`, { method: 'POST', body: raw,
    headers: { 'x-retell-signature': options.signature ?? await sign(raw) } })
  let queries = 0, bookings = 0
  const result = await receptionistRoute(request, { ...env, ...options.env }, {
    sql: { query: async text => { queries++; if (text.startsWith('select settings')) return [{ settings, revision: 0 }]; if (text.startsWith('update receptionist_calls set tool_count')) return [{ id: 'retell:call_test' }]; return [] } },
    owner: async () => { throw Error('Owner auth must not be invoked for signed provider requests') },
    availability: async () => ['9:00 AM - 11:00 AM'], book: async () => { bookings++; return { confirmed: true, jobId: 'synthetic' } },
  })
  return { result, queries, bookings }
}
test('invalid signature rejected before database access', async () => {
  const r = await route('getBusinessPolicies', {}, { signature: 'bad' }); assert.equal(r.result.status, 401); assert.equal(r.queries, 0)
})

test('preview diagnostics contain only a fixed stage and status', async () => {
  const messages = [], previous = console.warn
  console.warn = message => messages.push(JSON.parse(message))
  try {
    await route('getBusinessPolicies', { privateText: 'must-not-be-logged' }, {
      signature: 'bad', env: { AI_RECEPTIONIST_DEPLOYMENT: 'preview' },
    })
    assert.deepEqual(messages, [{ event: 'receptionist_request_failed', stage: 'signature', status: 401 }])
  } finally { console.warn = previous }
})

test('management API key is never a fallback for the designated webhook key', async () => {
  const r = await route('getBusinessPolicies', {}, { env: { RETELL_WEBHOOK_API_KEY: undefined } })
  assert.equal(r.result.status, 503)
  assert.equal(r.queries, 0)
})

test('only the designated webhook key verifies provider requests', async () => {
  const r = await route('getBusinessPolicies', {}, { env: { RETELL_API_KEY: 'different-management-key' } })
  assert.equal(r.result.status, 200)
})
test('disabled environment rejected before database access', async () => {
  const r = await route('getBusinessPolicies', {}, { env: { AI_RECEPTIONIST_ENABLED: 'false' } }); assert.equal(r.result.status, 503); assert.equal(r.queries, 0)
})
test('availability explicitly does not reserve', async () => {
  const r = await route('checkAvailability', { date: '2026-11-02' }); assert.equal(r.result.status, 200); assert.equal(r.result.value.reserved, false)
})
test('unapproved booking never calls persistence', async () => {
  const r = await route('createBooking', input); assert.equal(r.result.status, 409); assert.equal(r.bookings, 0); assert.equal(r.result.value.confirmed, false)
})
test('owner endpoints require existing owner authentication', async () => {
  let queried = false
  await assert.rejects(receptionistRoute(new Request('https://example.com/api/receptionist/settings'), env, { sql: { query: async () => { queried = true } }, owner: async () => { throw Error('Forbidden') } }), /Forbidden/)
  assert.equal(queried, false)
})

test('real PostgreSQL: atomic booking, retries, conflicts, time off, rollback and outbox', async () => {
  const schema = `receptionist_test_${Date.now()}`
  const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 5432), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', max: 8, options: `-c search_path=${schema}` })
  const query = async (text, values) => (await pool.query(text, values)).rows
  let created = false
  try {
    assert.deepEqual((await query('select current_database() as db,current_user as username'))[0], { db: 'webhook_test', username: 'webhook_test' })
    await query(`create schema ${schema}`); created = true
    await query(`create table jobs(id text primary key,customer text,phone text,email text,address text,appliance text,issue text,
      details text,job_text text,service_date date,service_window text,status text,invoice numeric,paid boolean,finance_items jsonb,
      payments jsonb,model_photo_attachments jsonb,lat numeric,lng numeric,created_by_user_id text,booking_source text);
      create table booking_sessions(id text primary key,job_id text,device_hash text,ip_hash text,source text,phone text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table booking_risk_events(id text primary key,session_id text,job_id text,event text,risk_score int,decision text,reasons jsonb);
      create table availability_blocks(blocked_date date,all_day boolean,service_window text)`)
    await query(readFileSync(resolve(root, 'migrations/2026-09-09_add_booking_requests.sql'), 'utf8').replaceAll('public.', `${schema}.`))
    const migration = readFileSync(resolve(root, 'migrations/2026-10-16_ai_receptionist.sql'), 'utf8')
    await query(migration); await query(migration)
    await query('update receptionist_settings set settings=$1::jsonb', [JSON.stringify(settings)])
    const addCall = async () => {
      const id = `retell:${crypto.randomUUID()}`
      await query('insert into receptionist_calls(id,provider,provider_call_id,caller_phone) values($1,$2,$1,$3)', [id, 'retell', input.phone])
      return id
    }
    let checks = 0
    const checkResults = await Promise.all([1, 2].map(() => checkReceptionistPush({ query }, 'synthetic-owner', async () => { checks++ })))
    assert.equal(checks, 1)
    assert.equal(checkResults.filter(result => !result.replay).length, 1)
    assert.equal((await checkReceptionistPush({ query }, 'synthetic-owner', async () => { checks++ })).status, 'accepted')
    assert.equal(checks, 1)
    let located = 0
    const run = async (callId, change = {}, fail = false) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const client = await pool.connect()
        try {
          await client.query('begin isolation level serializable')
          const result = await booking.persistPhoneBooking((text, values) => client.query(text, values), {
            callId, input: booking.bookingInput({ ...input, ...change }), newJobId: `J-${crypto.randomUUID()}`,
            locate: async () => { located++; return { lat: 39.9, lng: -86.1 } }, requireLeadTime: () => {},
          })
          if (fail) throw Error('Synthetic rollback')
          await client.query('commit'); return result
        } catch (e) {
          await client.query('rollback')
          if (!['40001', '40P01'].includes(e.code) || attempt === 3) throw e
        } finally { client.release() }
      }
    }
    const callId = await addCall()
    const pair = await Promise.all([run(callId), run(callId)])
    assert.equal(pair[0].jobId, pair[1].jobId)
    assert.equal(pair.filter(r => !r.replay).length, 1)
    const count = async table => (await query(`select count(*)::int as n from ${table}`))[0].n
    assert.equal(await count('jobs'), 1)
    assert.equal(await count('receptionist_notifications'), 1)
    const locatesBeforeReplay = located
    assert.equal((await run(callId)).replay, true)
    assert.equal(located, locatesBeforeReplay)
    assert.equal((await query('select job_text,details,booking_source from jobs'))[0].job_text, '')
    await assert.rejects(run(callId, { customer: 'Different person' }), /different booking/)
    await assert.rejects(run(await addCall()), /no longer available/)
    assert.equal(await count('jobs'), 1)
    await query("insert into availability_blocks values('2026-11-03',true,null)")
    await assert.rejects(run(await addCall(), { date: '2026-11-03' }), /no longer available/)
    await assert.rejects(run(await addCall(), { date: '2026-11-04', service: { ...service, requestedService: 'compressor' } }), /not eligible/)
    await assert.rejects(run(await addCall(), { date: '2026-11-04', zip: '46201' }), /outside/)
    await assert.rejects(run(await addCall(), { date: '2026-11-04' }, true), /Synthetic rollback/)
    assert.equal(await count('jobs'), 1)
    assert.equal(await count('receptionist_notifications'), 1)
    const a = await addCall(), b = await addCall()
    const race = await Promise.allSettled([run(a, { date: '2026-11-05' }), run(b, { date: '2026-11-05' })])
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await count('jobs'), 2)
    assert.equal(await count('receptionist_notifications'), 2)
    const sent = []
    const deliver = async jobId => { sent.push(jobId) }
    await Promise.all([processReceptionistPush({ query }, deliver), processReceptionistPush({ query }, deliver)])
    assert.equal(sent.length, 2)
    assert.equal(new Set(sent).size, 2)
    await processReceptionistPush({ query }, deliver)
    assert.equal(sent.length, 2)
    await query("update receptionist_notifications set status='pending' where call_id=$1", [callId])
    let failedAttempts = 0
    await processReceptionistPush({ query }, async () => { failedAttempts++; throw Error('Ambiguous delivery') })
    assert.equal(failedAttempts, 1)
    assert.equal((await query('select status from receptionist_notifications where call_id=$1', [callId]))[0].status, 'unknown')
    await processReceptionistPush({ query }, deliver)
    assert.equal(sent.length, 2)
    await query("update receptionist_notifications set status='sending',updated_at=now()-interval '6 minutes' where call_id=$1", [callId])
    await processReceptionistPush({ query }, deliver)
    assert.equal(sent.length, 2)
    assert.equal((await query('select status from receptionist_notifications where call_id=$1', [callId]))[0].status, 'unknown')
    const callbackArgs = { customer: input.customer, phone: input.phone, reason: 'Please call back', confirmed: true }
    const callbackRoute = async args => {
      const raw = JSON.stringify({ call: { ...call, call_id: callId.slice('retell:'.length) }, args })
      return receptionistRoute(new Request('https://example.com/api/receptionist/providers/retell/tools/requestCallback', {
        method: 'POST', body: raw, headers: { 'x-retell-signature': await sign(raw) },
      }), env, { sql: { query }, owner: async () => { throw Error('Unexpected owner authentication') } })
    }
    assert.equal((await callbackRoute(callbackArgs)).status, 200)
    assert.equal((await callbackRoute(callbackArgs)).status, 200)
    assert.equal((await callbackRoute({ ...callbackArgs, reason: 'Changed reason' })).status, 409)
    assert.equal((await query('select outcome from receptionist_calls where id=$1', [callId]))[0].outcome, 'booked')
    assert.equal((await query('select count(*)::int as n from receptionist_callbacks where call_id=$1', [callId]))[0].n, 1)
    const metricId = `call_metrics_${Date.now()}`, start = Date.now() - 60000, end = Date.now()
    const webhook = async (event, cost, latency) => {
      const raw = JSON.stringify({ event, call: { ...call, call_id: metricId, start_timestamp: start, end_timestamp: end,
        call_cost: { combined_cost: cost }, latency: { e2e: { p50: latency } }, transcript: 'NEVER STORE', recording_url: 'NEVER STORE' } })
      return receptionistRoute(new Request('https://example.com/api/receptionist/providers/retell/webhook', {
        method: 'POST', body: raw, headers: { 'x-retell-signature': await sign(raw) },
      }), env, { sql: { query }, owner: async () => { throw Error('Unexpected owner authentication') } })
    }
    assert.equal((await webhook('call_analyzed', 15.5, 800)).status, 200)
    assert.equal((await webhook('call_analyzed', 999, 999)).status, 200)
    assert.equal((await webhook('call_ended', 10, 600)).status, 200)
    assert.equal((await webhook('call_started', undefined, undefined)).status, 200)
    const [metrics] = await query('select * from receptionist_calls where provider_call_id=$1', [metricId])
    assert.equal(Number(metrics.cost_cents), 15.5)
    assert.equal(Number(metrics.latency_ms), 800)
    assert.equal(metrics.started_at.getTime(), start)
    assert.equal(metrics.ended_at.getTime(), end)
    assert.equal(metrics.outcome, 'ended')
    assert.ok(!JSON.stringify(metrics).includes('NEVER STORE'))
    const stats = await receptionistRoute(new Request('https://example.com/api/receptionist/stats'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(stats.status, 200)
    assert.equal(stats.value.priced_calls, 1)
    assert.equal(Number(stats.value.recorded_cost_cents), 15.5)
    assert.equal(stats.value.total_calls, await count('receptionist_calls'))
    await query("update jobs set status='canceled' where id=$1", [pair[0].jobId])
    await assert.rejects(run(callId), /no longer active/)
  } finally {
    if (created) await query(`drop schema ${schema} cascade`)
    await pool.end()
  }
})
