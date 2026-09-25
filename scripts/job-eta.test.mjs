import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function loadRouting({ denied = false, routes = [{ durationMillis: 1680000 }], fail = false } = {}) {
  const module = {}
  const calls = []
  const navigator = { geolocation: { getCurrentPosition(ok, error, options) {
    assert.equal(options.maximumAge, 0)
    if (denied) error({ code: 1 })
    else ok({ timestamp: Date.now(), coords: { latitude: 39.7, longitude: -86.1, accuracy: 20 } })
  } } }
  const google = { maps: { async importLibrary(name) {
    assert.equal(name, 'routes')
    return { Route: { async computeRoutes(request) {
      calls.push(request)
      if (fail) throw new Error('provider detail')
      return { routes }
    } } }
  } } }
  new Function('exports', 'navigator', 'google', ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(module, navigator, google)
  return { module, calls }
}

const exports = {}
const source = readFileSync(new URL('../src/jobEta.ts', import.meta.url), 'utf8')
new Function('exports', ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(exports)

test('fixed template and nearest minute without buffer', () => {
  assert.equal(exports.etaMessage('David', 27.4 * 60000).minutes, 27)
  assert.deepEqual(exports.etaMessage('David', 27.7 * 60000), {
    minutes: 28, text: "Hello, David. I'm on the way, I'll be there in 28 minutes. Thanks.",
  })
  for (const invalid of [NaN, Infinity, -1]) assert.throws(() => exports.etaMessage('David', invalid))
})

test('recipient validation blocks missing address/phone/name and URI injection', () => {
  assert.deepEqual(exports.etaRecipient('David Smith', '(317) 555-0123', ' 100 Test St '), {
    firstName: 'David', phone: '3175550123', address: '100 Test St',
  })
  assert.throws(() => exports.etaRecipient('David', '3175550123', ''), /address is missing/)
  assert.throws(() => exports.etaRecipient('David', '3175550123?body=x', 'Test'), /phone number is missing/)
  assert.throws(() => exports.etaRecipient('', '3175550123', 'Test'), /name is missing/)
})

test('composer uses SENDTO and never has SMS send permission', () => {
  const java = readFileSync(new URL('../android/app/src/main/java/com/alex/appliancerepair/SmsComposerPlugin.java', import.meta.url), 'utf8')
  assert.match(java, /Intent.ACTION_SENDTO/)
  assert.match(java, /"sms_body"/)
  assert.doesNotMatch(java, /SmsManager|sendTextMessage/)
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8')
  assert.doesNotMatch(manifest, /android.permission.SEND_SMS/)
})

test('uses provider driving duration, current coordinates and traffic-aware route', async () => {
  const { module, calls } = loadRouting()
  assert.equal(await module.drivingDuration('100 Test St'), 1680000)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].travelMode, 'DRIVING')
  assert.equal(calls[0].routingPreference, 'TRAFFIC_AWARE')
  assert.equal(calls[0].destination, '100 Test St')
  assert.deepEqual(calls[0].origin, { lat: 39.7, lng: -86.1 })
})

test('permission denial prevents routing; no-route and provider error never invent ETA', async () => {
  const denied = loadRouting({ denied: true })
  await assert.rejects(denied.module.drivingDuration('Test'), /Allow location access/)
  assert.equal(denied.calls.length, 0)
  for (const config of [{ routes: [] }, { routes: [{}] }, { fail: true }]) {
    await assert.rejects(loadRouting(config).module.drivingDuration('Test'), /Cannot calculate driving ETA/)
  }
})
