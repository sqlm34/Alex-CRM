import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateFeeds, validateConfig, writeFeeds, main, MERCHANT_WEBSITE, BOOKING_ACTION_URL } from './google-actions-feeds.mjs'

// Synthetic data exists only in offline tests, never in a deployable example.
const fixture = () => ({ environment: 'sandbox', googlePartnerId: '12345', googleFeedVersionConfirmed: true, ownerDataConfirmed: true, merchantWebsite: MERCHANT_WEBSITE, bookingActionUrl: BOOKING_ACTION_URL, locale: 'en-US', merchants: [{ entityId: 'test-only-merchant', linkId: 'test-only-link', name: 'Offline Test Business', telephone: '+12025550123', address: { country: 'US', locality: 'Test City', region: 'IN', postal_code: '46000', street_address: '123 Test Street' }, services: [{ serviceId: 'test-only-service', name: 'Test repair', category: 'Test services', actionUrl: BOOKING_ACTION_URL, landingPageVerified: true, priceInterpretation: 'INTERPRETATION_NOT_DISPLAYED', durationInterpretation: 'INTERPRETATION_NOT_DISPLAYED' }] }] })
const timestamp = 1788912000

test('current entity/action v2/services and three exact descriptors; deterministic and no internal metadata', () => {
  const config = fixture()
  const before = structuredClone(config)
  const files = generateFeeds(config, timestamp)
  assert.deepEqual(files, generateFeeds(config, timestamp))
  assert.deepEqual(config, before)
  assert.equal(Object.keys(files).length, 6)
  for (const name of ['reservewithgoogle.entity', 'reservewithgoogle.action.v2', 'glam.service.v0']) {
    const filename = `${name}-${timestamp}_0001.json`
    assert.deepEqual(JSON.parse(files[`${name}-${timestamp}.filesetdesc.json`]), { generation_timestamp: timestamp, name, data_file: [filename] })
    assert.ok(JSON.parse(files[filename]).data.length)
  }
  const entity = JSON.parse(files[`reservewithgoogle.entity-${timestamp}_0001.json`]).data[0]
  const action = JSON.parse(files[`reservewithgoogle.action.v2-${timestamp}_0001.json`]).data[0]
  const service = JSON.parse(files[`glam.service.v0-${timestamp}_0001.json`]).data[0]
  assert.equal(entity.url, MERCHANT_WEBSITE)
  assert.deepEqual(action, { entity_id: entity.entity_id, link_id: 'test-only-link', url: BOOKING_ACTION_URL, actions: [{ appointment_info: {} }] })
  assert.equal(service.merchant_id, entity.entity_id)
  assert.deepEqual(service.service_price, { price_interpretation: 'INTERPRETATION_NOT_DISPLAYED' })
  assert.deepEqual(service.service_duration, { duration_interpretation: 'INTERPRETATION_NOT_DISPLAYED' })
  assert.deepEqual(service.localized_service_name.localized_value, [{ locale: 'en-US', value: 'Test repair' }])
  assert.doesNotMatch(JSON.stringify(files), /googlePartnerId|landingPageVerified|ACTION_LINK_TYPE|rwg_token/)
})

for (const [label, mutate] of [
  ['production', c => { c.environment = 'production' }],
  ['missing Google ID', c => { delete c.googlePartnerId }],
  ['placeholder', c => { c.merchants[0].name = 'TODO_FROM_BUSINESS_OWNER' }],
  ['missing approval', c => { c.googleFeedVersionConfirmed = false }],
  ['missing owner confirmation', c => { c.ownerDataConfirmed = false }],
  ['swapped URLs', c => { c.bookingActionUrl = MERCHANT_WEBSITE }],
  ['wrong website', c => { c.merchantWebsite = BOOKING_ACTION_URL }],
  ['bad locale', c => { c.locale = 'en_US' }],
  ['bad country', c => { c.merchants[0].address.country = 'XX' }],
  ['missing street', c => { delete c.merchants[0].address.street_address }],
  ['bad phone', c => { c.merchants[0].telephone = '555' }],
  ['duplicate entity', c => { c.merchants.push(structuredClone(c.merchants[0])) }],
  ['unmapped second merchant', c => { c.merchants.push({...structuredClone(c.merchants[0]),entityId:'second',linkId:'second-link'}) }],
  ['duplicate service', c => { c.merchants[0].services.push(structuredClone(c.merchants[0].services[0])) }],
  ['no services', c => { c.merchants[0].services = [] }],
  ['unverified landing', c => { c.merchants[0].services[0].landingPageVerified = false }],
  ['foreign link', c => { c.merchants[0].services[0].actionUrl = 'https://example.com/booking' }],
  ['HTTP', c => { c.merchants[0].services[0].actionUrl = BOOKING_ACTION_URL.replace('https:', 'http:') }],
  ['token in feed', c => { c.merchants[0].services[0].actionUrl += '?rwg_token=secret' }],
  ['unsupported price', c => { c.merchants[0].services[0].priceInterpretation = 'INTERPRETATION_EXACT' }],
  ['unknown schema field', c => { c.upload = true }],
]) test(`rejects ${label}`, () => { const c = fixture(); mutate(c); assert.throws(() => validateConfig(c)) })

test('rejects invalid timestamps and unresolved shipped example', async () => {
  for (const value of [undefined, 0, -1, 1.5, NaN, '1788912000', Number.MAX_SAFE_INTEGER]) assert.throws(() => generateFeeds(fixture(), value))
  const config = JSON.parse(await readFile(new URL('../config/google-actions-feeds.example.json', import.meta.url), 'utf8'))
  assert.throws(() => generateFeeds(config, timestamp))
})

test('offline exclusive writes outside git; invalid config has no output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'google-actions-feeds-test-'))
  try {
    const out = join(temp, 'sandbox')
    const result = await writeFeeds(fixture(), timestamp, out)
    assert.equal((await readdir(out)).length, 6)
    for (const name of result.files) assert.equal(await readFile(join(out, name), 'utf8'), generateFeeds(fixture(), timestamp)[name])
    await assert.rejects(writeFeeds(fixture(), timestamp, out), /EEXIST/)
    await assert.rejects(writeFeeds(fixture(), timestamp, 'relative-dir'))
    await assert.rejects(writeFeeds(fixture(), timestamp, new URL('../forbidden-output', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
    const invalid = fixture(); invalid.ownerDataConfirmed = false
    await assert.rejects(writeFeeds(invalid, timestamp, join(temp, 'invalid')))
    assert.deepEqual(await readdir(temp), ['sandbox'])
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('CLI rejects upload, schedule, missing and duplicate flags without IO', async () => {
  for (const args of [[], ['--upload', 'true'], ['--schedule', 'daily'], ['--config', 'x', '--config', 'y'], ['--timestamp', '1']]) await assert.rejects(main(args), /CLI/)
})
