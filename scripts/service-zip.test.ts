import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { normalizeServiceZip, deniedNewVisitZip, deniedNewVisitAddress } from '../shared/service-zip'
import { serviceZipDecision, serviceAreaDecision } from '../shared/receptionist-area'
import { bookingInput, persistPhoneBooking } from '../worker/receptionist/booking'
import { areaInput } from '../worker/mcp/schemas'
import { createBackend } from '../worker/mcp/backend'
import { defaultReceptionistSettings } from '../shared/receptionist'

const variants = ['46268', ' 46268 ', '46268-1234', '4 6 2 6 8', 'four six two six eight', 'FOUR, SIX, TWO, SIX, EIGHT']
const settings = { ...defaultReceptionistSettings, publicPhone: '+13175550143', enabled: true, testMode: true, serviceZips: ['46268', '46032'], zipOnlyZips: ['46268', '46032'], zipCoverage: { '46268': 'full' as const } }
const details = { customer: 'Synthetic', phone: '+13175550142', address: '123 Test Street, Indianapolis, IN', zip: '46268', service: { appliance: 'Washer repair', issue: 'Not draining', diagnosis: 'unknown', requestedService: 'repair' }, date: '2027-01-12', window: '9:00 AM - 11:00 AM', confirmed: true }

test('ZIP normalization accepts ZIP+4 and spoken digits without guessing malformed input', () => {
  for (const zip of variants) {
    assert.equal(normalizeServiceZip(zip), '46268')
    assert.equal(deniedNewVisitZip(zip), true)
    assert.equal(areaInput.parse({ zip }).zip, '46268')
    assert.equal(bookingInput({ ...details, zip }).zip, '46268')
  }
  for (const zip of ['462681234', '46268junk', 'four sixty two six eight', '4626', null]) assert.equal(normalizeServiceZip(zip), '')
  assert.equal(deniedNewVisitZip('46032-1234'), false)
})

test('explicit denial overrides stale owner-approved ZIP and full coverage settings', async () => {
  for (const zip of variants) {
    assert.deepEqual(serviceZipDecision(settings, zip), { covered: false, reason: 'zip_not_serviced', nextAction: 'declineService' })
    assert.equal((await serviceAreaDecision(settings, zip, { lat: 39.95, lng: -86.15, precision: 'ROOFTOP' })).reason, 'zip_not_serviced')
  }
  assert.equal(serviceZipDecision(settings, '46032-1234').covered, true)
})

test('full-address ZIP cannot bypass separate ZIP and does not confuse house numbers', () => {
  for (const suffix of ['46268', '46268-1234', 'four six two six eight']) assert.equal(deniedNewVisitAddress(`123 Test St, Indianapolis IN ${suffix}, USA`), true)
  assert.equal(deniedNewVisitAddress('46268 Test St, Carmel IN 46032'), false)
})

test('phone and web voice persistence deny before geocoding or writes; not manual-review callbacks', async () => {
  for (const channel of ['phone', 'web'] as const) {
    let located = false
    const query = async (sql: string) => {
      if (sql.startsWith('select settings')) return { rows: [{ settings, revision: 0 }] }
      if (sql.startsWith('select id,ended_at')) return { rows: [{ id: 'synthetic', ended_at: null }] }
      if (sql.startsWith('select payload_hash')) return { rows: [] }
      throw Error(`Unexpected write: ${sql}`)
    }
    await assert.rejects(persistPhoneBooking(query, { callId: 'synthetic', input: bookingInput(details), channel, newJobId: 'test', requireLeadTime() {}, locate: async () => { located = true; throw Error('No geocoder expected') } }), /46268 is not serviced/)
    assert.equal(located, false)
  }
})

test('MCP refuses new visits before geocoding, confirmation intents or booking writes', async () => {
  const backend = createBackend({ query: async (sql: string) => {
    if (sql.startsWith('select settings')) return [{ settings, revision: 0 }]
    if (sql.startsWith('select job_id') || sql.startsWith('select token_hash')) return []
    throw Error(`Unexpected write: ${sql}`)
  }, locate: async () => { throw Error('Unexpected geocoding') } } as any)
  const user = { id: 'synthetic', phone: details.phone, scopes: ['booking:create'] }
  for (const zip of variants) await assert.rejects(backend.execute('createBooking', { ...details, zip, email: 'test@example.com', idempotencyKey: crypto.randomUUID() }, user), /zip_not_serviced/)
})

test('MCP policies omit denied ZIP from every stale group and retain allowed policy', async () => {
  const stale = { ...settings, northIndianapolis: { primaryZips: ['46268'], candidateZips: [] } }
  const original = structuredClone(stale)
  const backend = createBackend({ query: async (sql: string) => {
    assert.ok(sql.startsWith('select settings'))
    return [{ settings: stale, revision: 0 }]
  } } as any)
  const policy = await backend.execute('getBusinessPolicies', {}, undefined) as any
  assert.deepEqual(policy.serviceZips, ['46032'])
  assert.deepEqual(policy.zipOnlyZips, ['46032'])
  assert.deepEqual(policy.zipCoverage, {})
  assert.deepEqual(policy.northIndianapolis, { primaryZips: [], candidateZips: [] })
  assert.deepEqual(stale, original)
})

test('public submission executes deny before risk writes; receipt replay stays ahead of validation', async () => {
  const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function normalizePublicBooking(')
  const end = source.indexOf('\nfunction bookingServices()', start)
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const normalize = new Function('deniedNewVisitAddress', 'deniedNewVisitZip', 'ApiHttpError', 'normalizeSmsPhone', 'normalizePhone', 'normalizeEmail', `${compiled}; return normalizePublicBooking`)(deniedNewVisitAddress, deniedNewVisitZip, Error, (x: string) => x, (x: string) => x, (x: string) => x)
  await assert.rejects(normalize({}, { ...details, email: 'test@example.com', address: '123 Test St, Indianapolis IN 46268-1234' }, {}, []), /46268 is not serviced/)
  const route = source.slice(source.indexOf("if (url.pathname === '/api/public/bookings'"), source.indexOf('const statements = bookingPersistenceStatements(receipt, job'))
  assert.ok(route.indexOf('if (previous.length) return') < route.indexOf('await normalizePublicBooking'))
  const phone = readFileSync(new URL('../worker/receptionist/booking.ts', import.meta.url), 'utf8')
  assert.ok(phone.indexOf('if (previous.length)') < phone.indexOf('deniedNewVisitAddress(input.address)'))
})
