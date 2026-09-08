import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const source = readFileSync(new URL('../src/stripeCapabilitiesCheck.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm' })
const { checkStripeCapabilities } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('manual diagnostic returns only validated capability fields', async () => {
  let calls = 0
  const result = await checkStripeCapabilities(true, async () => {
    calls++
    return { stripePaymentProtocolVersion: 2, supportsExternalClientSecret: true, unexpected: 'not displayed' }
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { status: 'supported', protocolVersion: 2, externalClientSecret: true })
})

test('web or missing plugin never invokes native capability method', async () => {
  const result = await checkStripeCapabilities(false, () => { throw new Error('must not call') })
  assert.equal(result.status, 'unavailable')
})

test('old protocol requires update and native errors are not exposed', async () => {
  for (const response of [
    { stripePaymentProtocolVersion: 1, supportsExternalClientSecret: true },
    { stripePaymentProtocolVersion: 2, supportsExternalClientSecret: false },
  ]) assert.equal((await checkStripeCapabilities(true, async () => response)).status, 'update-required')
  const result = await checkStripeCapabilities(true, async () => { throw new Error('private native error') })
  assert.deepEqual(result, { status: 'unavailable', protocolVersion: null, externalClientSecret: null })
})

test('missing method, malformed responses and timeout fail safely', async () => {
  for (const response of [null, {}, { stripePaymentProtocolVersion: 2, supportsExternalClientSecret: 'true' }]) {
    assert.equal((await checkStripeCapabilities(true, async () => response)).status, 'unavailable')
  }
  assert.equal((await checkStripeCapabilities(true, () => new Promise(() => {}), 5)).status, 'unavailable')
  assert.equal((await checkStripeCapabilities(true, () => ({}).getCapabilities())).status, 'unavailable')
})

test('owner-only component uses existing wrapper and no payment APIs', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const component = readFileSync(new URL('../src/StripeCapabilitiesDiagnostic.tsx', import.meta.url), 'utf8')
  assert.match(app, /isOwner \? \(\s*<>\s*<StripeCapabilitiesDiagnostic/)
  assert.match(app, /getCapabilities=\{\(\) => StripeTerminal.getCapabilities\(\)\}/)
  assert.match(component, /onClick=\{\(\) => void check\(\)\}/)
  assert.match(component, /if \(inFlight.current\) return/)
  assert.match(component, /if \(!mounted.current\) return/)
  assert.doesNotMatch(component + source, /fetch\(|collectPayment|connection_tokens|createStripePaymentAttempt|authToken|console\./)
})
