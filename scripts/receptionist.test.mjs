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

test('call start push uses the existing call navigation and short expiry', () => {
  const { callStartedPushMessage, callEndedPushMessage } = load('worker/receptionist/notifications.ts')
  const call = { id: 'retell:test-start', caller_phone: '+13175550142' }
  const message = callStartedPushMessage('test-token', call)
  assert.equal(message.data.event, 'receptionist_call')
  assert.equal(message.data.call_id, call.id)
  assert.equal(message.android.ttl, '60s')
  assert.equal(message.android.notification.tag, callEndedPushMessage('test-token', call).android.notification.tag)
  assert.match(message.notification.title, /Call in progress/)
  assert.match(message.notification.body, /3175550142/)
  assert.match(callStartedPushMessage('test-token', { ...call, caller_phone: '' }).notification.body, /Unknown caller/)
})

test('website call start push identifies Book by Voice without claiming a booking', () => {
  const { callStartedPushMessage, callEndedPushMessage } = load('worker/receptionist/notifications.ts')
  const call = { id: 'retell:web-start', caller_phone: '', channel: 'web' }
  const message = callStartedPushMessage('test-token', call)
  assert.match(message.notification.title, /Book by Voice/)
  assert.match(message.notification.body, /Appointment not confirmed yet/)
  assert.doesNotMatch(message.notification.body, /Unknown caller/)
  assert.equal(message.data.call_id, call.id)
  assert.equal(message.data.event, 'receptionist_call')
  assert.equal(message.android.notification.icon, 'ic_stat_site_booking')
  assert.equal(message.android.ttl, '60s')
  assert.equal(message.android.notification.tag, callEndedPushMessage('test-token', call).android.notification.tag)
  const routes = readFileSync(resolve(root, 'worker/receptionist/routes.ts'), 'utf8')
  assert.match(routes, /if \(event === 'call_started' && !call.ended\)/)
  assert.match(routes, /authorizedWebCall\(payload.call, env, sql\)/)
})

test('call start push is claimed once and ambiguous sends are not repeated', async () => {
  const { processReceptionistCallPush } = load('worker/receptionist/notifications.ts')
  for (const fails of [false, true]) {
    let pending = true, count = 0, status
    const sql = { query: async (query, params) => {
      if (query.includes('with candidate')) {
        if (!pending) return []
        pending = false
        return [{ event_key: 'start-key', call_id: 'test', event_type: 'call_start_push_sending' }]
      }
      if (query.includes('event_type=$2')) status = params[1]
      return []
    } }
    const send = async (id, phase) => { count++; assert.equal(phase, 'started'); if (fails) throw new Error('uncertain') }
    await processReceptionistCallPush(sql, send)
    await processReceptionistCallPush(sql, send)
    assert.equal(count, 1)
    assert.equal(status, fails ? 'call_start_push_unknown' : 'call_start_push_sent')
  }
})
test('owner service scope: refrigerator symptoms and microwave installations', () => {
  const settings = { ...domain.defaultReceptionistSettings }
  const request = { appliance: 'Refrigerator repair', issue: 'Not cooling', diagnosis: 'unknown', requestedService: 'diagnostic' }
  assert.equal(domain.serviceEligibility(settings, request).eligible, true)
  for (const part of ['filter-drier', 'filter dryer', 'condenser coil', 'evaporator coil', 'compressor', 'refrigerant', 'brazing']) {
    assert.equal(domain.serviceEligibility(settings, { ...request, issue: `Replace ${part}`, requestedService: 'sealed_system' }).eligible, false)
    assert.equal(domain.serviceEligibility(settings, { ...request, issue: `Replace ${part}` }).eligible, false)
  }
  for (const appliance of ['Microwave repair', 'Built-in microwave']) {
    assert.equal(domain.serviceEligibility(settings, { ...request, appliance, issue: 'Not heating' }).reason, 'clarify_microwave_installation')
  }
  const combo = { ...request, appliance: 'Built-in microwave oven combination', issue: 'Microwave above wall oven does not heat' }
  assert.equal(domain.serviceEligibility(settings, combo).eligible, true)
  for (const issue of ['Over-the-range microwave', 'Above the stove', 'Countertop microwave']) {
    assert.equal(domain.serviceEligibility(settings, { ...combo, issue }).eligible, false)
  }
  assert.equal(domain.serviceEligibility({ ...settings, appliances: ['Washer repair'] }, combo).eligible, false)
})
test('time off creates schedule dates without jobs and keeps existing jobs', () => {
  const { withTimeOffDates } = load('src/schedule-time-off.ts')
  const groups = [{ date: '2026-10-18', jobs: [{ id: 'one' }] }]
  const blocks = [{ id: 'a', blocked_date: '2026-10-17', all_day: false, service_window: '9:00 AM - 11:00 AM' }, { id: 'b', blocked_date: '2026-10-18', all_day: true }]
  const result = withTimeOffDates(groups, blocks)
  assert.deepEqual(result.map(g => g.date), ['2026-10-17','2026-10-18'])
  assert.equal(result[0].jobs.length, 0)
  assert.equal(result[0].blocks[0].service_window, blocks[0].service_window)
  assert.equal(result[1].jobs[0].id, 'one')
  assert.equal(groups.length, 1)
  assert.equal(withTimeOffDates(groups, []).length, 1)
})
test('job source distinguishes Emily, web voice and manual phone bookings', () => {
  const { jobSourceLabel } = load('src/bookingSource.ts')
  assert.equal(jobSourceLabel({ bookingSourceDetail: 'phone_assistant' }), 'Phone · Emily')
  assert.equal(jobSourceLabel({}), 'Phone')
  assert.equal(jobSourceLabel({ bookingSource: 'website', bookingSourceDetail: 'voice_assistant' }), 'Website voice assistant')
  assert.equal(jobSourceLabel({ bookingSource: 'website' }), 'Website')
})
test('postal address defaults cover all service ZIPs without authorizing coverage', () => {
  const { postalLocation } = load('shared/receptionist-postal.ts')
  const { approvedServiceZips } = load('shared/receptionist-area.ts')
  for (const zip of approvedServiceZips) {
    assert.equal(postalLocation(zip).state, 'IN')
    assert.equal(postalLocation(zip).geographicallyVerified, false)
  }
  assert.equal(postalLocation('46250').city, 'Indianapolis')
  assert.equal(postalLocation('46032').city, 'Carmel')
  assert.equal(postalLocation('46040').city, 'Fortville')
  for (const zip of ['99999', '', '4625', 'toString']) assert.equal(postalLocation(zip), null)
  const { withPostalAddress } = load('worker/receptionist/conversation.ts')
  const prompt = withPostalAddress('Existing instructions')
  assert.ok(prompt.startsWith('Existing instructions'))
  assert.equal(withPostalAddress(prompt), prompt)
  assert.equal(withPostalAddress(prompt + '\nKeep this'), prompt + '\nKeep this')
})
test('phone echo instructions preserve context and are idempotent and safe', () => {
  const { withPhoneEcho, phoneEchoInstructions } = load('worker/receptionist/conversation.ts')
  const original = 'Existing booking and greeting rules.'
  const result = withPhoneEcho(original)
  assert.ok(result.startsWith(original))
  assert.equal(withPhoneEcho(result), result)
  assert.equal(withPhoneEcho(result + '\nLater rules'), result + '\nLater rules')
  assert.throws(() => withPhoneEcho('[PHONE_ECHO_HANDLING_START]'), /Malformed/)
  for (const text of ['at most once per call', 'skip the speakerphone request', 'Never treat a suspected echo', 'Only say a callback was recorded after the tool confirms', 'Do not hang up just because of echo', 'Do not claim you detected speakerphone']) assert.ok(phoneEchoInstructions.includes(text), text)
})
const callCalendar = load('shared/receptionist-calendar.ts')
test('call timeline groups dates in Indianapolis and sorts without mutating input', () => {
  const input = [{ started_at: '2026-11-01T06:00:00Z' }, { started_at: '2026-11-01T03:59:00Z' }, { started_at: '2026-11-01T04:01:00Z' }]
  const groups = callCalendar.groupCallsByDate(input)
  assert.deepEqual(groups.map(g => g.date), ['2026-11-01', '2026-10-31'])
  assert.equal(groups[0].calls[0].started_at, input[0].started_at)
  assert.equal(input[0].started_at, '2026-11-01T06:00:00Z')
  assert.deepEqual(callCalendar.groupCallsByDate([]), [])
})
test('call calendar uses Indianapolis dates and validates day boundaries', () => {
  assert.equal(callCalendar.callDate('2026-10-19T03:59:59Z'),'2026-10-18')
  assert.equal(callCalendar.callDate('2026-10-19T04:00:00Z'),'2026-10-19')
  assert.equal(callCalendar.callDate('2026-12-01T04:59:59Z'),'2026-11-30')
  assert.equal(callCalendar.shiftCallDate('2026-11-01',1),'2026-11-02')
  assert.equal(callCalendar.validCallDate('2026-02-30'),false)
  assert.equal(callCalendar.validCallDate('2028-02-29'),true)
})
const { deleteConversation } = load('worker/receptionist/delete-conversation.ts')
test('conversation deletion requires owner confirmation and never deletes an active call', async () => {
  let queries = 0
  const deps = { owner: async () => 'owner', sql: { query: async () => { queries++; return [] } } }
  const denied = await receptionistRoute(new Request('https://example.com/api/receptionist/calls/test', { method: 'DELETE', body: JSON.stringify({ confirmed: false }) }), {}, deps)
  assert.equal(denied.status, 400); assert.equal(queries, 0)
  await assert.rejects(receptionistRoute(new Request('https://example.com/api/receptionist/calls/test', { method: 'DELETE' }), {}, { ...deps, owner: async () => { throw Error('Forbidden') } }), /Forbidden/)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ call_id: 'call_test', call_status: 'ongoing' })
    await assert.rejects(deleteConversation({ query: async () => [{ provider: 'retell', provider_call_id: 'call_test', ended_at: null }] }, 'test', 'owner', { RETELL_API_KEY: 'test' }), /has ended/)
  } finally { globalThis.fetch = originalFetch }
})
test('missing end webhook is recovered only from verified terminal provider status', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const status of ['ended', 'error', 'ongoing', 'registered', 'unknown']) {
      const queries = [], requests = []
      globalThis.fetch = async (url, options) => {
        requests.push(options.method || 'GET')
        return options.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ call_id: 'call_test', call_status: status })
      }
      const sql = { query: async q => { queries.push(q); return q.startsWith('select provider,') ? [{ provider: 'retell', provider_call_id: 'call_test', ended_at: null }] : [{ deleted: true }] } }
      if (['ended', 'error'].includes(status)) {
        assert.equal((await deleteConversation(sql, 'test', 'owner', { RETELL_API_KEY: 'test' })).deleted, true)
        assert.deepEqual(requests, ['GET', 'DELETE'])
        assert.ok(queries.some(q => q.startsWith('update receptionist_calls')))
      } else {
        await assert.rejects(deleteConversation(sql, 'test', 'owner', { RETELL_API_KEY: 'test' }), /has ended/)
        assert.deepEqual(requests, ['GET']); assert.equal(queries.length, 1)
      }
    }
  } finally { globalThis.fetch = originalFetch }
})
test('conversation deletion retains CRM data on provider failure and supports safe retries', async () => {
  const originalFetch = globalThis.fetch
  let purged = false
  const sql = { query: async query => query.startsWith('select provider,') ? [{ provider: 'retell', provider_call_id: 'call_test', ended_at: '2026-10-18' }] : (purged = true, [{ deleted: true }]) }
  try {
    for (const status of [401, 422, 500, 302]) {
      globalThis.fetch = async () => new Response(null, { status })
      await assert.rejects(deleteConversation(sql, 'test', 'owner', { RETELL_API_KEY: 'test' }), /Unable to delete/)
      assert.equal(purged, false)
    }
    for (const status of [204, 404]) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.retellai.com/v2/delete-call/call_test')
        assert.equal(options.method, 'DELETE'); assert.equal(options.redirect, 'manual')
        return new Response(null, { status })
      }
      assert.equal((await deleteConversation(sql, 'test', 'owner', { RETELL_API_KEY: 'test' })).deleted, true)
    }
    globalThis.fetch = async url => String(url).includes('/get-agent/') ? Response.json({ agent_id: 'expected-agent' }) : Response.json({ message: 'Cannot find requested asset under given api key.' }, { status: 422 })
    assert.equal((await deleteConversation(sql, 'test', 'owner', { RETELL_API_KEY: 'test', RETELL_AGENT_ID: 'expected-agent' })).deleted, true)
    globalThis.fetch = async () => { throw Error('Must not call provider again') }
    assert.equal((await deleteConversation({ query: async query => query.includes('receptionist_deleted_calls') ? [{ call_id: 'test' }] : [] }, 'test', 'owner', {})).deleted, true)
  } finally { globalThis.fetch = originalFetch }
})
const conversation = load('worker/receptionist/conversation.ts')
test('phone closing uses Indianapolis weekday, evening threshold and DST', () => {
  for (const [date, wish] of [
    ['2026-10-19T20:59:00Z', 'day'], ['2026-10-19T21:00:00Z', 'evening'],
    ['2026-10-16T13:00:00Z', 'weekend'], ['2026-10-17T23:00:00Z', 'weekend'],
    ['2026-10-19T03:59:00Z', 'weekend'], ['2026-10-19T04:00:00Z', 'day'],
    ['2026-10-16T03:59:00Z', 'evening'], ['2026-10-16T04:00:00Z', 'weekend'],
    ['2026-12-14T21:59:00Z', 'day'], ['2026-12-14T22:00:00Z', 'evening'],
  ]) assert.equal(conversation.closingContext(new Date(date)).wish, `Have a good ${wish}.`)
})
test('phone tone update preserves existing rules and is idempotent', () => {
  const original = 'Existing booking, recording, and greeting rules.'
  const updated = conversation.withPhoneClosing(original)
  assert.ok(updated.startsWith(original))
  assert.equal(conversation.withPhoneClosing(updated), updated)
  assert.match(updated, /Only if createBooking confirmed/)
  assert.match(updated, /If the tool is unavailable/)
})
const web = load('worker/receptionist/web.ts')
test('web calls have no daily quota and can recover ended leases for repeated bookings', async () => {
  const originalFetch = globalThis.fetch
  let lease = null, callId = null, count = 0
  try {
    globalThis.fetch = async url => {
      if (String(url).includes('/v2/get-call/')) return Response.json({ call_id: callId, agent_id: 'web-agent', call_status: 'ended' })
      if (String(url).endsWith('/get-concurrency')) return Response.json({ current_concurrency: 0, concurrency_limit: 5 })
      return Response.json({ call_id: `call_${++count}`, access_token: 'test-only' })
    }
    const sql = { query: async (query, values) => {
      if (query.includes('insert into receptionist_web_limits')) {
        assert.match(values[0], /^burst:/)
        assert.equal(values[1], 6)
      }
      if (query.includes('set session_id=$1')) { if (lease) return []; lease = values[0]; return [{ session_id: lease }] }
      if (query.startsWith('select w.id')) return lease ? [{ id: lease, provider_call_id: callId }] : []
      if (query.includes('set lease_until=now()')) { if (lease !== values[0]) return []; lease = null; return [{ session_id: values[0] }] }
      if (query.includes('set provider_call_id')) callId = values[1]
      return [{ used: 1 }]
    } }
    const env = { RECEPTIONIST_WEB_ENABLED: 'true', RETELL_API_KEY: 'test-only', RETELL_WEB_AGENT_ID: 'web-agent', RETELL_WEB_AGENT_VERSION: 'latest_published', RECEPTIONIST_WEB_HASH_SECRET: 'test-only' }
    for (let i = 1; i <= 60; i++) assert.equal((await web.createAuthorizedWebCall(env, sql, 'test-ip')).call_id, `call_${i}`)
  } finally { globalThis.fetch = originalFetch }
})
test('rapid web starts release the lease without creating a paid call', async () => {
  const originalFetch = globalThis.fetch
  let released = false
  try {
    globalThis.fetch = async url => {
      assert.ok(String(url).endsWith('/get-concurrency'))
      return Response.json({ current_concurrency: 0, concurrency_limit: 5 })
    }
    const sql = { query: async query => {
      if (query.includes('set session_id=$1')) return [{ session_id: 'test' }]
      if (query.includes('insert into receptionist_web_limits')) return []
      if (query.includes('set lease_until=now()')) { released = true; return [] }
      throw Error('Unexpected query')
    } }
    await assert.rejects(web.createAuthorizedWebCall({ RECEPTIONIST_WEB_ENABLED: 'true', RETELL_API_KEY: 'test', RETELL_WEB_AGENT_ID: 'test', RETELL_WEB_AGENT_VERSION: 'latest_published', RECEPTIONIST_WEB_HASH_SECRET: 'test' }, sql, 'test-ip'), /wait one minute/)
    assert.equal(released, true)
  } finally { globalThis.fetch = originalFetch }
})
test('web capacity recovers ended provider calls, never active calls or a newer lease', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const status of ['ended', 'error', 'ongoing', 'registered']) {
      let released = false
      globalThis.fetch = async () => Response.json({ call_id: 'call_old', agent_id: 'web-agent', call_status: status })
      const sql = { query: async (query, values) => {
        if (query.startsWith('select')) return [{ id: 'old-session', provider_call_id: 'call_old' }]
        assert.match(query, /session_id=\$1/)
        assert.deepEqual(values, ['old-session'])
        released = true
        return [{ session_id: 'old-session' }]
      } }
      assert.equal(await web.recoverEndedWebLease({ RETELL_WEB_AGENT_ID: 'web-agent' }, sql), ['ended', 'error'].includes(status))
      assert.equal(released, ['ended', 'error'].includes(status))
    }
    globalThis.fetch = async () => { throw Error('offline') }
    assert.equal(await web.recoverEndedWebLease({}, { query: async () => [{ id: 'old', provider_call_id: 'call_old' }] }), false)
  } finally { globalThis.fetch = originalFetch }
})
test('web confirmation requires a private session and returns calendar only for a booked job', async () => {
  const token = '00000000-0000-4000-8000-000000000001'
  const env = { RECEPTIONIST_WEB_ORIGINS: 'https://alex-repair.com', RETELL_WEB_AGENT_ID: 'web-agent' }
  const request = (value = token, origin = 'https://alex-repair.com') => new Request('https://api.example/web/result', {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ token: value }),
  })
  let touched = false
  const absent = { query: async () => { touched = true; return [] } }
  await assert.rejects(web.webBookingResult(request('call_public'), env, absent))
  await assert.rejects(web.webBookingResult(request(token, 'https://evil.test'), env, absent))
  assert.equal(touched, false)
  assert.deepEqual(await web.webBookingResult(request(), env, absent), { confirmed: false })
  const result = await web.webBookingResult(request(), env, { query: async (query, args) => {
    assert.deepEqual(args, [token, 'web-agent'])
    assert.match(query, /j.id=c.job_id/)
    assert.match(query, /service_date::text/)
    assert.match(query, /interval '1 hour'/)
    assert.match(query, /j.status not in/)
    return [{ id: 'TEST', address: '1 Civic Square, Carmel, IN 46032', appliance: 'Washer', service_date: '2026-10-19', service_window: '9:00 AM - 11:00 AM', status: 'scheduled' }]
  } })
  assert.equal(result.confirmed, true)
  assert.equal(new URL(result.calendarUrl).origin, 'https://calendar.google.com')
  assert.match(result.calendarFile, /BEGIN:VCALENDAR/)
  assert.match(result.message, /text you/i)
})
test('web drafts are bounded and cannot confirm appointments', async () => {
  assert.deepEqual(web.webDraftInput({ brand: ' Bosch ', issue: 'Not draining' }), { brand: 'Bosch', issue: 'Not draining' })
  assert.deepEqual(web.webDraftInput({ address: '' }), { address: '' })
  assert.throws(() => web.webDraftInput({ confirmed: true }))
  assert.throws(() => web.webDraftInput({ issue: 'x'.repeat(1201) }))
  assert.throws(() => web.webDraftInput({ phone: 123 }))
  const result = await web.webBookingResult(new Request('https://api.example/web/result', { method: 'POST', headers: { Origin: 'https://alex-repair.com' }, body: JSON.stringify({ token: '00000000-0000-4000-8000-000000000001' }) }),
    { RECEPTIONIST_WEB_ORIGINS: 'https://alex-repair.com', RETELL_WEB_AGENT_ID: 'web-agent' },
    { query: async () => [{ id: null, draft: { brand: 'Bosch' }, outcome: 'callback_requested' }] })
  assert.equal(result.confirmed, false)
  assert.equal(result.callbackRecorded, true)
  assert.deepEqual(result.draft, { brand: 'Bosch' })
  assert.equal(result.calendarUrl, undefined)
})
test('web origin is explicit and phone concurrency keeps headroom', () => {
  const env = { RECEPTIONIST_WEB_ORIGINS: 'https://alex-repair.com' }
  assert.equal(web.webOrigin(new Request('https://api.example/web', { headers: { Origin: 'https://alex-repair.com' } }), env), 'https://alex-repair.com')
  for (const origin of ['', 'https://alex-repair.com.evil.test', 'http://alex-repair.com']) {
    assert.throws(() => web.webOrigin(new Request('https://api.example/web', { headers: { Origin: origin } }), env))
  }
  assert.equal(web.hasPhoneCapacity({ current_concurrency: 2, concurrency_limit: 5 }), true)
  assert.equal(web.hasPhoneCapacity({ current_concurrency: 3, concurrency_limit: 5 }), false)
  assert.equal(web.hasPhoneCapacity({ current_concurrency: -1, concurrency_limit: 5 }), false)
  assert.equal(web.hasPhoneCapacity({ current_concurrency: '0', concurrency_limit: 5 }), false)
})
test('web calls require a server minted session and the separate agent', async () => {
  const env = { RETELL_WEB_AGENT_ID: 'web-agent' }
  const call = { call_type: 'web_call', agent_id: 'web-agent', call_id: 'call_test' }
  const sql = { query: async () => [{ id: 'session-test' }] }
  assert.equal((await web.authorizedWebCall(call, env, sql)).channel, 'web')
  await assert.rejects(web.authorizedWebCall(call, env, { query: async () => [] }))
  await assert.rejects(web.authorizedWebCall({ ...call, agent_id: 'phone-agent' }, env, sql))
  await assert.rejects(web.authorizedWebCall({ ...call, call_type: 'phone_call' }, env, sql))
})
test('disabled public web start never reaches database or provider', async () => {
  let touched = false
  const sql = { query: async () => { touched = true; return [] } }
  await assert.rejects(web.startWebCall(new Request('https://api.example/web', {
    method: 'POST', headers: { Origin: 'https://alex-repair.com' }, body: '{}',
  }), { RECEPTIONIST_WEB_ORIGINS: 'https://alex-repair.com' }, sql))
  assert.equal(touched, false)
})
const locations = load('shared/receptionist-location.ts')
test('call location uses stated address or labelled ZIP, never phone digits', () => {
  assert.deepEqual(locations.statedLocation('Customer is from Plainfield, ZIP code 46168.'), { city: 'Plainfield', zip: '46168' })
  assert.deepEqual(locations.statedLocation('1 Civic Square, Carmel, IN 46032'), { city: 'Carmel', zip: '46032' })
  assert.deepEqual(locations.statedLocation('Phone +14632488429. Invoice 46250.'), { city: null, zip: null })
  assert.equal(locations.statedLocation('ZIP 46250 or ZIP 46240').zip, null)
  assert.deepEqual(locations.statedLocation('City: Plainfield; ZIP: 46168-1234'), { city: 'Plainfield', zip: '46168' })
  assert.deepEqual(locations.statedLocation('Service ZIP 46168 in Plainfield is outside configured coverage.'), { city: 'Plainfield', zip: '46168' })
  assert.equal(locations.callLocationMap({ city: 'Plainfield', zip: null }), null)
  assert.equal(new URL(locations.callLocationMap({ city: 'Plainfield', zip: '46168' })).searchParams.get('query'), '46168, USA')
})
test('monthly locations count calls, group city and ZIP, retain unknowns', () => {
  const report = locations.summarizeCallLocations([{ city: 'Carmel', zip: '46032' }, { city: 'carmel', zip: '46033' }, { city: 'Carmel', zip: '46032' }, { city: null, zip: null }])
  assert.equal(report.total, 4)
  assert.equal(report.unknown, 1)
  assert.equal(report.cities[0].calls, 3)
  assert.deepEqual(report.cities[0].zips, [{ zip: '46032', calls: 2 }, { zip: '46033', calls: 1 }])
})
const area = load('shared/receptionist-area.ts')
test('all-call push includes declined and booked calls without claiming callback consent', () => {
  const { callEndedPushMessage } = load('worker/receptionist/notifications.ts')
  for (const job_id of [null, 'job-test']) {
    const message = callEndedPushMessage('test-token', { id: 'retell:test', caller_phone: '+13175550142', duration_ms: 87000, job_id })
    assert.equal(message.data.event, 'receptionist_call')
    assert.equal(message.data.call_id, 'retell:test')
    assert.match(message.notification.body, /1:27/)
    assert.doesNotMatch(message.notification.body, /waiting|requested a callback/i)
    assert.equal(message.android.notification.tag, 'call-retell:test')
  }
})
test('push icons distinguish web hangup, site booking and phone Emily in both Android paths', () => {
  const { callEndedPushMessage } = load('worker/receptionist/notifications.ts')
  for (const [channel, job_id, icon] of [['web', null, 'ic_stat_call_ended'], ['web', 'job', 'ic_stat_site_booking'], ['phone', 'job', 'ic_stat_phone_assistant']]) {
    const message = callEndedPushMessage('test', { id: 'test', caller_phone: '', channel, job_id })
    assert.equal(message.android.notification.icon, icon)
    assert.equal(message.data.notificationIcon, icon)
    assert.match(message.notification.title, channel === 'web' ? /Book by Voice/ : /Phone Emily/)
  }
  const { jobPushPresentation } = load('shared/push-presentation.ts')
  assert.equal(jobPushPresentation('created', 'website', null, 'Old').title, 'Site booking · New order')
  assert.equal(jobPushPresentation('created', null, 'phone_assistant', 'Old').icon, 'ic_stat_phone_assistant')
  assert.equal(jobPushPresentation('assigned', 'website', null, 'Assigned').title, 'Assigned')
})
test('all-call push claims once and marks uncertain delivery without retry', async () => {
  const { processReceptionistCallPush } = load('worker/receptionist/notifications.ts')
  let pending = true, attempts = 0, status
  const sql = { query: async (query, args) => {
    if (query.includes('with candidate')) { if (!pending) return []; pending = false; return [{ event_key: 'test:owner_call_push', call_id: 'test' }] }
    if (args) status = args[1]
    return []
  } }
  const send = async () => { attempts++; throw new Error('ambiguous transport') }
  await processReceptionistCallPush(sql, send)
  await processReceptionistCallPush(sql, send)
  assert.equal(attempts, 1)
  assert.equal(status, 'call_push_unknown')
})
// Synthetic test polygon, NOT approved service geometry. Its southern edge
// bends to prove that coverage is not a universal latitude comparison.
const testBoundary = { type: 'Polygon', coordinates: [[[-86.22, 39.89], [-86.16, 39.895], [-86.10, 39.89], [-86.10, 39.94], [-86.22, 39.94], [-86.22, 39.89]]], source: 'https://example.com/synthetic-test-only', reviewNotes: 'Synthetic tests only; never deploy.' }
test('service boundary: north, south, directly on, and near edge', async () => {
  const config = { serviceZips: ['46240'], indianapolisBoundary: testBoundary }
  const hash = await area.boundaryFingerprint(testBoundary)
  for (const [lat, lng, expected] of [[39.91, -86.16, true], [39.88, -86.16, false], [39.895, -86.16, false], [39.8951, -86.16, false], [39.892, -86.16, false], [39.892, -86.21, true]]) {
    assert.equal((await area.serviceAreaDecision(config, '46240', { lat, lng, city: 'Indianapolis', precision: 'ROOFTOP' }, hash)).covered, expected)
  }
})
test('service boundary: candidate ZIP never bypasses approval or geometry', async () => {
  const config = { serviceZips: ['46240'], indianapolisBoundary: testBoundary }
  const location = { lat: 39.91, lng: -86.16, precision: 'ROOFTOP' }
  assert.equal((await area.serviceAreaDecision(config, '46240', location)).covered, false)
  const hash = await area.boundaryFingerprint(testBoundary)
  assert.equal((await area.serviceAreaDecision(config, '46240', { ...location, precision: 'RANGE_INTERPOLATED' }, hash)).covered, false)
  assert.equal((await area.serviceAreaDecision(config, '46201', { ...location, city: 'Indianapolis' }, hash)).covered, false)
  const edited = { ...testBoundary, reviewNotes: 'Changed geometry review' }
  assert.equal((await area.serviceAreaDecision({ ...config, indianapolisBoundary: edited }, '46240', location, hash)).covered, false)
})
test('service boundary: existing approved city ZIPs remain available', async () => {
  const serviceZips = ['46032', '46033', '46037', '46038', '46040', '46055', '46060', '46062', '46074', '46077']
  for (const zip of serviceZips) assert.equal((await area.serviceAreaDecision({ serviceZips }, zip, { lat: 40, lng: -86 })).covered, true)
})
test('service boundary: reject malformed, unclosed and nonlocal geometry', () => {
  assert.throws(() => area.validateAreaBoundary({ ...testBoundary, coordinates: [[[-86, 40], [-86, 41], [-85, 40]]] }))
  assert.throws(() => area.validateAreaBoundary({ ...testBoundary, coordinates: [[[40, -86], [41, -86], [40, -85], [40, -86]]] }))
  assert.throws(() => area.validateAreaBoundary({ ...testBoundary, source: '' }))
  assert.throws(() => area.validateAreaBoundary({ ...testBoundary, coordinates: [[[-86.2,39.9],[-86.1,39.95],[-86.2,39.95],[-86.1,39.9],[-86.2,39.9]]] }))
})
const retell = load('worker/receptionist/retell.ts')
const booking = load('worker/receptionist/booking.ts')
const { processReceptionistPush, processReceptionistCallbackPush, checkReceptionistPush, callbackPushMessage } = load('worker/receptionist/notifications.ts')
test('callback alert includes actionable details and high priority without exposing them on lock screen', () => {
  const message = callbackPushMessage('synthetic-token', 'synthetic-call', { customer: 'Test Customer', phone: '+13175550142', reason: 'Address review' })
  assert.match(message.notification.title, /WAITING FOR A CALLBACK/)
  assert.match(message.notification.body, /Test Customer\n\+13175550142\nAddress review/)
  assert.equal(message.data.call_id, 'synthetic-call')
  assert.equal(message.android.notification.notification_priority, 'PRIORITY_MAX')
  assert.equal(message.android.notification.visibility, 'PRIVATE')
  assert.equal(message.android.notification.tag, 'callback-synthetic-call')
})
const config = load('worker/receptionist/retell-config.ts')
test('recording prompt is opt-in and announces recording before intake', () => {
  const prompt = config.retellRecordingProductionPrompt()
  assert.equal(config.retellProductionPrompt.includes(config.retellRecordingNotice), false)
  assert.equal(prompt.split(config.retellRecordingNotice).length - 1, 1)
  assert.ok(prompt.indexOf(config.retellRecordingNotice) < prompt.indexOf('How can I help you today?'))
  assert.match(prompt, /before collecting customer details, even if the caller speaks first/)
  assert.match(prompt, /You cannot pause or disable recording/)
  assert.match(prompt, /do not continue intake/)
  assert.match(prompt, /Never claim to be human/)
  assert.match(prompt, /Only confirmed:true means the appointment was recorded/)
})
const { receptionistRoute, bookingEnabled } = load('worker/receptionist/routes.ts')
const settings = { ...domain.defaultReceptionistSettings, enabled: true, serviceZips: ['46032', '46240'], publicPhone: '+13175550142', transferPhone: '+13175550143' }
const service = { appliance: 'Washer repair', issue: 'Not draining', diagnosis: 'unknown', requestedService: 'diagnostic' }
const input = { customer: 'Synthetic Customer', phone: '+13175550142', address: '123 Synthetic Street, Carmel, IN', zip: '46032', service, date: '2026-11-02', window: '9:00 AM - 11:00 AM', confirmed: true }
const call = { call_id: 'call_test', agent_id: 'agent_test', to_number: '+13175550140', from_number: '+13175550142', direction: 'inbound', call_type: 'phone_call', call_status: 'ongoing' }
const env = { AI_RECEPTIONIST_DEPLOYMENT: 'preview', AI_RECEPTIONIST_ENABLED: 'true', RETELL_API_KEY: 'synthetic-test-secret', RETELL_WEBHOOK_API_KEY: 'synthetic-test-secret', RETELL_AGENT_ID: call.agent_id, RETELL_TEST_PHONE: call.to_number }
const { settingsModeAllowed } = load('worker/receptionist/mode.ts')

test('live booking requires an explicit production gate and matching database mode', () => {
  const live = { ...env, AI_RECEPTIONIST_DEPLOYMENT: 'production', AI_RECEPTIONIST_BOOKING_ENABLED: 'true', AI_RECEPTIONIST_GEOCODING_KEY: 'synthetic' }
  assert.equal(bookingEnabled(live), false)
  assert.equal(settingsModeAllowed(live, false), false)
  assert.equal(settingsModeAllowed(live, true), false)
  assert.equal(bookingEnabled({ ...live, AI_RECEPTIONIST_LIVE_ENABLED: 'true' }), true)
  assert.equal(settingsModeAllowed({ ...live, AI_RECEPTIONIST_LIVE_ENABLED: 'true' }, false), true)
  assert.equal(settingsModeAllowed({ ...live, AI_RECEPTIONIST_LIVE_ENABLED: 'true' }, true), false)
  assert.equal(settingsModeAllowed(env, false), false)
  assert.equal(settingsModeAllowed(env, true), true)
  assert.equal(settingsModeAllowed({}, true), false)
})

test('production tool configuration is restricted to the approved CRM API', () => {
  assert.throws(() => config.retellProductionTools('https://example.com'))
  assert.throws(() => config.retellProductionTools('https://alex-crm-receptionist-test.alexeasyrepair.workers.dev'))
  const tools = config.retellProductionTools('https://alex-crm-api.alexeasyrepair.workers.dev')
  assert.equal(tools.length, domain.receptionistTools.length)
  assert.ok(tools.every(tool => tool.url.startsWith('https://alex-crm-api.alexeasyrepair.workers.dev/api/receptionist/')))
  assert.ok(tools.every(tool => tool.max_retry === 0))
  assert.ok(!tools.find(tool => tool.name === 'createBooking').description.includes('test appointment'))
  assert.match(config.retellProductionPrompt, /Thank you for calling Alex Appliance Repair\. This is Emily\. How can I help you today\?/)
  assert.match(config.retellProductionPrompt, /answer briefly and truthfully/)
  assert.ok(!config.retellProductionPrompt.includes('Introduce yourself as an AI assistant'))
  assert.match(config.retellProductionPrompt, /Only confirmed:true/)
})
test('intake never requests model labels or photos by text', () => {
  const prompt = config.retellProductionPrompt
  assert.match(prompt, /approximately how many years old/)
  assert.match(prompt, /Accept unknown answers without blocking booking/)
  assert.match(prompt, /Do not ask for a model number/)
  assert.match(prompt, /Do not ask callers to send photos or model information by SMS/)
  assert.match(prompt, /createBooking.service.issue/)
  assert.doesNotMatch(prompt, /Do you have a photo|Could you please text the photo/)
})

test('conversation continuation never restarts intake or fabricates a callback after silence', () => {
  const prompt = config.retellProductionPrompt
  assert.match(prompt, /opening greeting only once per call/)
  assert.match(prompt, /never starts a new conversation/)
  assert.match(prompt, /After requestCallback returns recorded:true or createBooking returns callbackRecorded:true/)
  assert.match(prompt, /Never create a duplicate request merely because of silence/)
  assert.match(prompt, /Do not promise a callback time/)
})

test('diagnostics never reports booking enabled for disabled or mismatched database settings', async () => {
  const live = { ...env, AI_RECEPTIONIST_DEPLOYMENT: 'production', AI_RECEPTIONIST_LIVE_ENABLED: 'true', AI_RECEPTIONIST_BOOKING_ENABLED: 'true', AI_RECEPTIONIST_GEOCODING_KEY: 'synthetic' }
  for (const [stored, expected] of [[{ enabled: false, testMode: false }, false], [{ enabled: true, testMode: true }, false], [{ enabled: true, testMode: false }, true], [undefined, false]]) {
    const result = await receptionistRoute(new Request('https://example.com/api/receptionist/diagnostics'), live, {
      owner: async () => 'owner',
      sql: { query: async text => text.includes('to_regclass') ? [{ ready: true }] : text.includes('select settings') ? [{ settings: stored }] : [] },
    })
    assert.equal(result.value.bookingEnabled, expected)
  }
})
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
  assert.deepEqual(staged.serviceZips, area.approvedServiceZips)
  assert.equal(new Set(staged.serviceZips).size, 23)
  assert.deepEqual(staged.northIndianapolis, area.northIndianapolisDefaults)
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
test('uses only verified geocoder coordinates', () => assert.deepEqual(booking.geocodeLocation(geo, '46032'), { lat: 39.9, lng: -86.1, city: undefined, precision: geo.results[0].geometry.location_type }))
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
    startedAt: new Date(now - 10000).toISOString(), endedAt: new Date(now).toISOString(), costCents: 15.5, latencyMs: 0, durationMs: 10000, disconnectReason: null,
  })
  assert.deepEqual(retell.retellMetrics({ call_cost: { combined_cost: '0' }, latency: { e2e: { p50: -1 } } }), {
    startedAt: null, endedAt: null, costCents: null, latencyMs: null, durationMs: null, disconnectReason: null,
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
    sql: { query: async text => { queries++; if (text.startsWith('select settings')) return [{ settings: options.settings || settings, revision: 0 }]; if (text.startsWith('update receptionist_calls set tool_count')) return [{ id: 'retell:call_test' }]; return [] } },
    owner: async () => { throw Error('Owner auth must not be invoked for signed provider requests') },
    availability: async () => ['9:00 AM - 11:00 AM'], book: async () => { bookings++; if (options.bookingError) throw options.bookingError; return { confirmed: true, jobId: 'synthetic' } },
  })
  return { result, queries, bookings }
}
test('invalid signature rejected before database access', async () => {
  const r = await route('getBusinessPolicies', {}, { signature: 'bad' }); assert.equal(r.result.status, 401); assert.equal(r.queries, 0)
})
test('service boundary preflight requires full address and fails closed without geocoding', async () => {
  const north = { ...settings, serviceZips: ['46032', '46240'] }
  const missing = await route('checkServiceArea', { zip: '46240' }, { settings: north })
  assert.equal(missing.result.value.nextAction, 'collectFullAddress')
  const unavailable = await route('checkServiceArea', { zip: '46240', address: '123 Synthetic Street, Indianapolis, IN' }, { settings: north })
  assert.equal(unavailable.result.value.covered, false)
  assert.equal(unavailable.result.value.nextAction, 'requestCallback')
})

const northSettings = { ...settings, northIndianapolis: area.northIndianapolisDefaults, serviceZips: [...settings.serviceZips, ...area.indianapolisCandidateZips] }
test('23 ZIP policy is returned from settings and all ZIPs require a full address', async () => {
  const config = domain.validateReceptionistSettings(JSON.parse(readFileSync(resolve(root, 'worker/receptionist/approved-test-settings.json'), 'utf8')))
  const { result } = await route('getBusinessPolicies', {}, { settings: { ...config, enabled: true } })
  assert.deepEqual(result.value.serviceZips, area.approvedServiceZips)
  assert.deepEqual(result.value.zipCoverage, config.zipCoverage)
  for (const zip of area.approvedServiceZips) {
    assert.equal(area.serviceZipDecision(config, zip).nextAction, 'collectFullAddress')
    if (/^462/.test(zip) || ['46052', '46069', '46075'].includes(zip)) {
      assert.equal((await area.serviceAreaDecision(config, zip, { lat: 39.95, lng: -86.15, city: 'Unapproved city', precision: 'ROOFTOP' })).covered, false)
    }
  }
})
test('ZIP coverage statuses are validated and cannot bypass Indianapolis geometry', async () => {
  assert.throws(() => domain.validateReceptionistSettings({ ...settings, zipCoverage: { '46032': 'anything' } }))
  assert.throws(() => domain.validateReceptionistSettings({ ...settings, zipCoverage: { '99999': 'full' } }))
  const location = { lat: 39.95, lng: -86.15, precision: 'ROOFTOP' }
  for (const status of ['partial', 'manual']) {
    assert.equal((await area.serviceAreaDecision({ ...settings, zipCoverage: { '46032': status } }, '46032', location)).covered, false)
  }
  assert.equal((await area.serviceAreaDecision({ ...settings, zipCoverage: { '46240': 'full' } }, '46240', location)).covered, false)
  assert.equal((await area.serviceAreaDecision(settings, '46032', { lat: NaN, lng: NaN })).covered, false)
})
test('explicit ZIP-only approval covers all 23 without an address or geocoder', async () => {
  const config = { ...settings, serviceZips: area.approvedServiceZips, zipOnlyZips: area.approvedServiceZips }
  assert.deepEqual(domain.validateReceptionistSettings(config).zipOnlyZips, area.approvedServiceZips)
  assert.throws(() => domain.validateReceptionistSettings({ ...settings, zipOnlyZips: ['99999'] }))
  for (const zip of area.approvedServiceZips) {
    const { result } = await route('checkServiceArea', { zip, address: '' }, { settings: config, env: { AI_RECEPTIONIST_GEOCODING_KEY: undefined } })
    assert.equal(result.value.covered, true)
    assert.equal(result.value.postalLocation.zip, zip)
    assert.equal(result.value.postalLocation.state, 'IN')
    assert.equal(result.value.postalLocation.geographicallyVerified, false)
    assert.equal((await area.serviceAreaDecision(config, zip, { lat: NaN, lng: NaN })).covered, true)
  }
  assert.equal(area.serviceZipDecision(config, '99999').covered, false)
  assert.equal(area.serviceZipDecision(config, '4625').covered, false)
  const { result } = await route('getBusinessPolicies', {}, { settings: config })
  assert.equal(result.value.fullAddressVerificationRequired, false)
  assert.deepEqual(result.value.zipOnlyZips, area.approvedServiceZips)
})
const addressFixtures = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/north-indianapolis-addresses.json'), 'utf8'))
for (const fixture of addressFixtures.addresses) test(`North Indianapolis verified landmark: ${fixture.area} requires review, not an invented boundary`, async () => {
  assert.match(fixture.source, /^https:\/\//)
  const { result } = await route('checkServiceArea', { zip: fixture.zip, address: fixture.address }, { settings: northSettings })
  assert.equal(result.value.covered, false)
  assert.equal(result.value.nextAction, 'requestCallback')
  assert.equal(result.value.reason, fixture.outsideZipList ? 'outside_configured_zip_codes' : 'address_could_not_be_verified')
})
for (const zip of area.indianapolisCandidateZips) test(`North Indianapolis ${zip}: ZIP alone cannot book`, async () => {
  const { result } = await route('checkServiceArea', { zip, address: '' }, { settings: northSettings })
  assert.equal(result.value.nextAction, 'collectFullAddress')
  assert.equal(result.value.covered, false)
  const syntheticLocation = { lat: 39.91, lng: -86.16, city: 'Indianapolis', precision: 'ROOFTOP' }
  assert.equal((await area.serviceAreaDecision(northSettings, zip, syntheticLocation)).reason, 'boundary_pending_verification_and_owner_approval')
  const withPolygon = { ...northSettings, indianapolisBoundary: testBoundary }
  const hash = await area.boundaryFingerprint(testBoundary)
  assert.equal((await area.serviceAreaDecision(withPolygon, zip, syntheticLocation, hash)).covered, true)
  assert.equal((await area.serviceAreaDecision(withPolygon, zip, { ...syntheticLocation, lat: 39.88 }, hash)).covered, false)
})
for (const zip of [undefined, '', '462', 'ABCDE', '462400', 46240]) test(`ZIP validation: ${String(zip)}`, async () => {
  const { result } = await route('checkServiceArea', { zip }, { settings: northSettings })
  assert.equal(result.value.nextAction, 'collectZip')
  assert.equal(result.value.covered, false)
})
test('North Indianapolis groups are validated and policies use stored configuration', async () => {
  assert.throws(() => domain.validateReceptionistSettings({ ...northSettings, northIndianapolis: { primaryZips: ['46240'], candidateZips: ['46240'] } }))
  assert.throws(() => domain.validateReceptionistSettings({ ...northSettings, serviceZips: ['46032'] }))
  const { result } = await route('getBusinessPolicies', {}, { settings: northSettings })
  assert.deepEqual(result.value.northIndianapolis, northSettings.northIndianapolis)
  assert.match(config.retellProductionPrompt, /Emily/)
  assert.match(config.retellProductionPrompt, /owner approves coverage solely by ZIP/)
  assert.match(config.retellProductionPrompt, /Other|ZIPs outside zipOnlyZips/)
  assert.ok(!config.retellProductionPrompt.includes('75th Street'))
})
test('confirmed booking address failure records manual callback, never confirms a job', async () => {
  const r = await route('createBooking', input, { env: { AI_RECEPTIONIST_BOOKING_ENABLED: 'true', AI_RECEPTIONIST_GEOCODING_KEY: 'synthetic', AI_RECEPTIONIST_BOOKING_TEST_UNTIL: String(Date.now() + 60000) }, bookingError: new booking.AddressReviewRequired('Synthetic address review', 422) })
  assert.equal(r.result.status, 200)
  assert.equal(r.result.value.confirmed, false)
  assert.equal(r.result.value.callbackRecorded, true)
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

test('recording playback uses edge-compatible redirects and rejects provider redirects', async () => {
  const originalFetch = globalThis.fetch
  const request = new Request('https://example.com/api/receptionist/calls/synthetic/recording')
  const deps = { owner: async () => 'owner', sql: { query: async () => [{ provider_call_id: 'call_synthetic' }] } }
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'manual')
      assert.equal(options.headers.Authorization, 'Bearer current-account-key')
      assert.equal(url, 'https://api.retellai.com/v2/get-call/call_synthetic')
      return Response.json({ recording_url: 'https://example.com/synthetic.wav' })
    }
    const enabled = { ...env, RETELL_API_KEY: 'old-account-key', RETELL_WEBHOOK_API_KEY: 'current-account-key', AI_RECEPTIONIST_RECORDING_PLAYBACK_ENABLED: 'true' }
    assert.equal((await receptionistRoute(request, enabled, deps)).value.available, true)
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/redirect' } })
    assert.equal((await receptionistRoute(request, enabled, deps)).value.available, false)
  } finally { globalThis.fetch = originalFetch }
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
      payments jsonb,model_photo_attachments jsonb,lat numeric not null,lng numeric not null,created_by_user_id text,booking_source text,booking_source_detail text);
      create table booking_sessions(id text primary key,job_id text,device_hash text,ip_hash text,source text,phone text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table booking_risk_events(id text primary key,session_id text,job_id text,event text,risk_score int,decision text,reasons jsonb);
      create table availability_blocks(blocked_date date,all_day boolean,service_window text)`)
    const coordinatesMigration = readFileSync(resolve(root, 'migrations/2026-10-17_receptionist_optional_coordinates.sql'), 'utf8')
    await query(coordinatesMigration); await query(coordinatesMigration)
    await query(readFileSync(resolve(root, 'migrations/2026-09-09_add_booking_requests.sql'), 'utf8').replaceAll('public.', `${schema}.`))
    const migration = readFileSync(resolve(root, 'migrations/2026-10-16_ai_receptionist.sql'), 'utf8')
    await query(migration); await query(migration)
    const locationMigration = readFileSync(resolve(root, 'migrations/2026-10-17_receptionist_call_locations.sql'), 'utf8')
    await query(locationMigration); await query(locationMigration)
    const callbackMigration = readFileSync(resolve(root, 'migrations/2026-10-16_receptionist_callback_push.sql'), 'utf8')
    await query(callbackMigration); await query(callbackMigration)
    const abandonedMigration = readFileSync(resolve(root, 'migrations/2026-10-17_receptionist_abandoned_calls.sql'), 'utf8')
    await query(abandonedMigration); await query(abandonedMigration)
    const webMigration = readFileSync(resolve(root, 'migrations/2026-10-18_receptionist_web_calls.sql'), 'utf8')
    await query(webMigration); await query(webMigration)
    const sourceMigration = readFileSync(resolve(root, 'migrations/2026-10-18_phone_assistant_source.sql'), 'utf8')
    await query(sourceMigration); await query(sourceMigration)
    await query(readFileSync(resolve(root, 'migrations/2026-10-16_receptionist_vip.sql'), 'utf8'))
    const deletionMigration = readFileSync(resolve(root, 'migrations/2026-10-18_receptionist_delete.sql'), 'utf8')
    await query(deletionMigration); await query(deletionMigration)
    const original = { ...settings, serviceZips: [...settings.serviceZips, '46069', '46236'], indianapolisBoundary: testBoundary }
    await query('update receptionist_settings set settings=$1::jsonb', [JSON.stringify(original)])
    const northMigration = readFileSync(resolve(root, 'migrations/2026-10-16_receptionist_north_indianapolis.sql'), 'utf8')
    await query(northMigration)
    const [merged] = await query('select settings,revision from receptionist_settings')
    assert.ok(merged.settings.serviceZips.includes('46069'))
    assert.ok(merged.settings.serviceZips.includes('46236'))
    assert.equal(merged.settings.enabled, original.enabled)
    assert.equal(merged.settings.publicPhone, original.publicPhone)
    assert.equal(merged.settings.testMode, original.testMode)
    assert.equal(merged.settings.indianapolisBoundary, undefined)
    assert.deepEqual(merged.settings.northIndianapolis, { primaryZips: ['46240','46250','46260','46268'], candidateZips: ['46220','46278','46280','46290'] })
    await query(northMigration)
    assert.deepEqual((await query('select settings,revision from receptionist_settings'))[0], merged)
    const beforeImport = { ...merged.settings, indianapolisBoundary: testBoundary, serviceZips: [...merged.settings.serviceZips, '46001'] }
    await query('update receptionist_settings set settings=$1::jsonb', [JSON.stringify(beforeImport)])
    const zipMigration = readFileSync(resolve(root, 'migrations/2026-10-17_receptionist_service_zips.sql'), 'utf8')
    await query(zipMigration)
    const [imported] = await query('select settings,revision from receptionist_settings')
    for (const zip of area.approvedServiceZips) assert.ok(imported.settings.serviceZips.includes(zip))
    assert.ok(imported.settings.serviceZips.includes('46001'))
    assert.equal(imported.settings.serviceZips.length, 24)
    assert.deepEqual(imported.settings.indianapolisBoundary, testBoundary)
    assert.deepEqual(imported.settings.northIndianapolis, area.northIndianapolisDefaults)
    assert.deepEqual((await query('select settings from receptionist_area_backups'))[0].settings, beforeImport)
    await query(zipMigration)
    assert.deepEqual((await query('select settings,revision from receptionist_settings'))[0], imported)
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
    const run = async (callId, change = {}, fail = false, expectedTestMode = true, channel = 'phone') => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const client = await pool.connect()
        try {
          await client.query('begin isolation level serializable')
          const result = await booking.persistPhoneBooking((text, values) => client.query(text, values), {
            callId, channel, input: booking.bookingInput({ ...input, ...change }), newJobId: `J-${crypto.randomUUID()}`, expectedTestMode,
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
    // The booking transaction must enforce coverage even if the agent skips its preflight tool.
    await assert.rejects(run(await addCall(), { date: '2026-11-04', zip: '46240' }), /manual approval/)
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
    const callbackSent = []
    const callbackSender = async id => { callbackSent.push(id) }
    await Promise.all([processReceptionistCallbackPush({ query }, callbackSender), processReceptionistCallbackPush({ query }, callbackSender)])
    assert.deepEqual(callbackSent, [callId])
    await callbackRoute(callbackArgs)
    await processReceptionistCallbackPush({ query }, callbackSender)
    assert.deepEqual(callbackSent, [callId])
    await query("update receptionist_callbacks set push_status='pending' where call_id=$1", [callId])
    await processReceptionistCallbackPush({ query }, async () => { throw Error('Ambiguous callback delivery') })
    assert.equal((await query('select push_status from receptionist_callbacks where call_id=$1', [callId]))[0].push_status, 'unknown')
    await processReceptionistCallbackPush({ query }, callbackSender)
    assert.deepEqual(callbackSent, [callId])
    await query("update receptionist_callbacks set push_status='sending',push_updated_at=now()-interval '6 minutes' where call_id=$1", [callId])
    await processReceptionistCallbackPush({ query }, callbackSender)
    assert.equal((await query('select push_status from receptionist_callbacks where call_id=$1', [callId]))[0].push_status, 'unknown')
    await query("update receptionist_callbacks set status='resolved',push_status='pending' where call_id=$1", [callId])
    await processReceptionistCallbackPush({ query }, callbackSender)
    assert.deepEqual(callbackSent, [callId])
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
    await query('update receptionist_settings set settings=$1::jsonb', [JSON.stringify({ ...settings, testMode: false })])
    const liveCall = await addCall()
    await assert.rejects(run(liveCall, { date: '2026-11-06' }), /mode changed/)
    const liveBooking = await run(liveCall, { date: '2026-11-06' }, false, false)
    assert.equal(liveBooking.confirmed, true)
    await assert.rejects(run(await addCall(), { date: '2026-11-06' }, false, false), /no longer available/)
    await query('update receptionist_settings set settings=$1::jsonb', [JSON.stringify({ ...settings, serviceZips: area.approvedServiceZips })])
    const zipOnlyMigration = readFileSync(resolve(root, 'migrations/2026-10-17_receptionist_zip_only.sql'), 'utf8')
    await query(zipOnlyMigration)
    const [zipOnlySaved] = await query('select settings,revision from receptionist_settings')
    await query(zipOnlyMigration)
    assert.deepEqual((await query('select settings,revision from receptionist_settings'))[0], zipOnlySaved)
    const beforeZipOnly = located
    const zipOnlyResult = await run(await addCall(), { date: '2026-11-09', zip: '46250' })
    assert.equal(zipOnlyResult.confirmed, true)
    assert.equal(located, beforeZipOnly)
    const [unlocated] = await query('select lat,lng from jobs where id=$1', [zipOnlyResult.jobId])
    assert.deepEqual(unlocated, { lat: null, lng: null })
    await assert.rejects(run(await addCall(), { date: '2026-11-09', zip: '46250' }), /no longer available/)
    await assert.rejects(run(await addCall(), { date: '2026-11-10', zip: '99999' }), /outside/)
    const webCallId = await addCall()
    const webChange = { date: '2026-12-15', zip: '46032' }
    const webBooked = await run(webCallId, webChange, false, true, 'web')
    assert.equal(webBooked.confirmed, true)
    assert.deepEqual((await query('select booking_source,booking_source_detail from jobs where id=$1', [webBooked.jobId]))[0],
      { booking_source: 'website', booking_source_detail: 'voice_assistant' })
    assert.equal((await run(webCallId, webChange, false, true, 'web')).replay, true)
    await assert.rejects(run(await addCall(), webChange), /no longer available/)
    assert.equal((await query('select count(*)::int as n from receptionist_notifications where call_id=$1', [webCallId]))[0].n, 1)
    const abandonedCall = await addCall()
    await query("update receptionist_calls set ended_at=now()-interval '2 minutes',outcome='ended',disconnect_reason='user_hangup',duration_ms=25000 where id=$1", [abandonedCall])
    const completedCall = await addCall()
    await query("update receptionist_calls set ended_at=now()-interval '2 minutes',outcome='booked',job_id=$2,disconnect_reason='user_hangup' where id=$1", [completedCall, zipOnlyResult.jobId])
    const freshCall = await addCall()
    await query("update receptionist_calls set ended_at=now(),outcome='ended',disconnect_reason='user_hangup' where id=$1", [freshCall])
    const droppedPushes = []
    await processReceptionistCallbackPush({ query }, async id => { droppedPushes.push(id) })
    await processReceptionistCallbackPush({ query }, async id => { droppedPushes.push(id) })
    assert.equal(droppedPushes.filter(id => id === abandonedCall).length, 1)
    assert.ok(!droppedPushes.includes(completedCall))
    assert.ok(!droppedPushes.includes(freshCall))
    const [dropped] = await query('select kind,phone,reason from receptionist_callbacks where call_id=$1', [abandonedCall])
    assert.equal(dropped.kind, 'abandoned')
    assert.match(dropped.reason, /25 seconds/)
    const abandonedList = await receptionistRoute(new Request('https://example.com/api/receptionist/abandoned'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.ok(abandonedList.value.some(call => call.id === abandonedCall && call.caller_phone && Number(call.duration_ms) === 25000))
    const recording = await receptionistRoute(new Request(`https://example.com/api/receptionist/calls/${encodeURIComponent(abandonedCall)}/recording`), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(recording.value.available, false)
    // Half-open Indianapolis month boundaries, including the November DST change.
    await query("update receptionist_calls set started_at='2026-01-01T00:00:00Z'")
    const times = ['2026-11-01T03:59:59Z', '2026-11-01T04:00:00Z', '2026-12-01T04:59:59Z', '2026-12-01T05:00:00Z']
    for (const started of times) {
      const callId = await addCall()
      await query("update receptionist_calls set started_at=$2,location_city='Plainfield',location_zip='46168' where id=$1", [callId, started])
    }
    const monthStats = await receptionistRoute(new Request('https://example.com/api/receptionist/location-stats?month=2026-11'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(monthStats.status, 200)
    assert.equal(monthStats.value.total, 2)
    assert.deepEqual(monthStats.value.cities, [{ city: 'Plainfield', calls: 2, zips: [{ zip: '46168', calls: 2 }] }])
    const invalidMonth = await receptionistRoute(new Request('https://example.com/api/receptionist/location-stats?month=2026-13'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(invalidMonth.status, 400)
    const dayCalls = await receptionistRoute(new Request('https://example.com/api/receptionist/calls?date=2026-11-01'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(dayCalls.status,200)
    assert.equal(dayCalls.value.length,1)
    await query("insert into receptionist_calls(id,provider,provider_call_id,caller_phone,started_at) select 'timeline-'||n,'retell','timeline-'||n,'+13175550142','2050-01-01'::timestamptz from generate_series(1,105) n")
    const timeline = await receptionistRoute(new Request('https://example.com/api/receptionist/calls?timeline=true'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.ok(timeline.value.length > 100)
    const recent = await receptionistRoute(new Request('https://example.com/api/receptionist/calls'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(recent.value.length, 100)
    await query("delete from receptionist_calls where id like 'timeline-%'")
    const badDate = await receptionistRoute(new Request('https://example.com/api/receptionist/calls?date=2026-02-30'), env, { sql: { query }, owner: async () => 'test-owner' })
    assert.equal(badDate.status,400)
    await assert.rejects(query('select receptionist_delete_conversation($1,$2)', [webCallId, 'test-owner']), /still active/)
    await query('update receptionist_calls set ended_at=now() where id=$1', [webCallId])
    const [toDelete] = await query('select provider_call_id from receptionist_calls where id=$1', [webCallId])
    await query("insert into receptionist_events values($1,$2,'call_ended',now())", [`${webCallId}:test-delete`, webCallId])
    await query("insert into receptionist_callbacks(call_id,customer,phone,reason) values($1,'Test','+13175550142','Test')", [webCallId])
    await query("insert into receptionist_vip_attempts(call_id,status) values($1,'denied')", [webCallId])
    await query("insert into receptionist_web_sessions(id,provider_call_id,agent_id,expires_at) values('delete-session',$1,'test',now())", [toDelete.provider_call_id])
    assert.equal((await query('select receptionist_delete_conversation($1,$2) as deleted', [webCallId, 'test-owner']))[0].deleted, true)
    assert.equal((await query('select call_id from receptionist_vip_attempts where call_id=$1', [webCallId])).length, 0)
    await query('drop table receptionist_vip_attempts')
    await query(readFileSync(resolve(root, 'migrations/2026-10-18_receptionist_delete_optional_vip.sql'), 'utf8'))
    const noVipCall = await addCall()
    await query('update receptionist_calls set ended_at=now() where id=$1', [noVipCall])
    await query("insert into receptionist_callbacks(call_id,customer,phone,reason) values($1,'Test','+13175550142','Test callback')", [noVipCall])
    assert.equal((await query('select receptionist_delete_conversation($1,$2) as deleted', [noVipCall, 'test-owner']))[0].deleted, true)
    assert.equal((await query('select call_id from receptionist_callbacks where call_id=$1', [noVipCall])).length, 0)
    for (const table of ['receptionist_events', 'receptionist_callbacks', 'receptionist_notifications']) assert.equal((await query(`select count(*)::int as n from ${table} where call_id=$1`, [webCallId]))[0].n, 0)
    assert.equal((await query('select id from jobs where id=$1', [webBooked.jobId])).length, 1)
    assert.equal((await query('select id from receptionist_web_sessions where provider_call_id=$1', [toDelete.provider_call_id])).length, 0)
    await query("insert into receptionist_calls(id,provider,provider_call_id,caller_phone) values($1,'retell',$2,'+13175550142')", [webCallId, toDelete.provider_call_id])
    assert.equal((await query('select id from receptionist_calls where id=$1', [webCallId])).length, 0)
    assert.equal((await query('select receptionist_delete_conversation($1,$2) as deleted', [webCallId, 'test-owner']))[0].deleted, true)
  } finally {
    if (created) await query(`drop schema ${schema} cascade`)
    await pool.end()
  }
})
