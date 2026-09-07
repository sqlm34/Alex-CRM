import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const androidPluginSource = readFileSync(
  new URL('../android/app/src/main/java/com/alex/appliancerepair/StripeTerminalPlugin.java', import.meta.url),
  'utf8',
)

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `Missing start marker: ${startNeedle}`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `Missing end marker: ${endNeedle}`)
  return source.slice(start, end)
}

test('server config exposes attempts enabled only from the exact feature flag', () => {
  assert.match(workerSource, /paymentAttemptsEnabled:\s*env\.STRIPE_PAYMENT_ATTEMPTS_ENABLED === 'true'/)
  assert.doesNotMatch(workerSource, /STRIPE_PAYMENT_ATTEMPTS_ENABLED[^\n]+!==\s*'false'/)
})

test('feature disabled keeps the legacy Tap to Pay path unchanged', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const legacyBranch = sliceBetween(collectPayment, 'if (!config.paymentAttemptsEnabled || !supportsServerAttempts)', 'return\\n        }'.replace(/\\n/g, '\n'))

  assert.match(legacyBranch, /StripeTerminal\.collectPayment\(\{[\s\S]*jobId: id,[\s\S]*amount,[\s\S]*currency,[\s\S]*locationId: config\.locationId/)
  assert.match(legacyBranch, /appendPayment\(job, amountDollars/)
  assert.match(legacyBranch, /syncJobPatch\(id, \{[\s\S]*payments: paidJob\.payments/)
})

test('capability negotiation happens before attempt creation', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const configEnabled = collectPayment.indexOf('if (config.paymentAttemptsEnabled)')
  const capabilityCheck = collectPayment.indexOf('StripeTerminal.getCapabilities()', configEnabled)
  const protocolCheck = collectPayment.indexOf('Number(capabilities.stripePaymentProtocolVersion || 0) >= 2', capabilityCheck)
  const clientSecretCapability = collectPayment.indexOf('capabilities.supportsExternalClientSecret === true', capabilityCheck)
  const legacyFallback = collectPayment.indexOf('if (!config.paymentAttemptsEnabled || !supportsServerAttempts)', clientSecretCapability)
  const attemptCreate = collectPayment.indexOf('createStripePaymentAttempt({ jobId: id, amountCents: amount, currency, idempotencyKey }, authToken)')

  assert.ok(configEnabled > 0)
  assert.ok(capabilityCheck > configEnabled)
  assert.ok(protocolCheck > capabilityCheck)
  assert.ok(clientSecretCapability > capabilityCheck)
  assert.ok(legacyFallback > clientSecretCapability)
  assert.ok(attemptCreate > legacyFallback)
})

test('old APK or unsupported plugin falls back before creating an attempt', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const capabilityBlock = sliceBetween(collectPayment, 'let supportsServerAttempts = false', 'if (!config.paymentAttemptsEnabled || !supportsServerAttempts)')
  const legacyBranch = sliceBetween(collectPayment, 'if (!config.paymentAttemptsEnabled || !supportsServerAttempts)', 'return\\n        }'.replace(/\\n/g, '\n'))

  assert.match(capabilityBlock, /catch \{[\s\S]*supportsServerAttempts = false/)
  assert.match(legacyBranch, /StripeTerminal\.collectPayment\(\{[\s\S]*jobId: id,[\s\S]*amount,[\s\S]*currency,[\s\S]*locationId: config\.locationId/)
  assert.doesNotMatch(legacyBranch, /createStripePaymentAttempt/)
  assert.doesNotMatch(legacyBranch, /clientSecret/)
})

test('enabled attempt flow creates server attempt then verifies before showing success', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const attemptCreate = collectPayment.indexOf('createStripePaymentAttempt({ jobId: id, amountCents: amount, currency, idempotencyKey }, authToken)')
  const terminalCollect = collectPayment.indexOf('StripeTerminal.collectPayment({', attemptCreate)
  const verify = collectPayment.indexOf('verifyStripePaymentAttempt(activeAttemptId, authToken)', terminalCollect)
  const freshGet = collectPayment.indexOf('fetchJobFromApi(id, authToken)', verify)
  const success = collectPayment.indexOf("message: 'Payment verified'", freshGet)

  assert.ok(attemptCreate > 0, 'attempt is created through Worker first')
  assert.ok(terminalCollect > attemptCreate, 'Android collect receives the server-created client secret')
  assert.ok(verify > terminalCollect, 'Worker verify runs after Android callback')
  assert.ok(freshGet > verify, 'fresh full job GET runs after verification')
  assert.ok(success > freshGet, 'success is shown only after Worker verification and refresh')
  assert.match(collectPayment, /clientSecret,\s*\n\s*\}\)/)
})

test('new Stripe attempt flow does not locally patch jobs.payments or trust Android success', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const attemptBranch = collectPayment.slice(collectPayment.indexOf('let storedAttempt = readStoredStripeAttempt'))

  assert.doesNotMatch(attemptBranch, /appendPayment\(job, amountDollars/)
  assert.doesNotMatch(attemptBranch, /syncJobPatch\(id, \{[\s\S]*payments:/)
  assert.match(attemptBranch, /if \(!verified\.recorded \|\| !verified\.job\)/)
  assert.match(attemptBranch, /No payment was marked successful locally/)
})

test('double tap and timeout recovery reuse one stored attempt and idempotency key', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')

  assert.match(collectPayment, /if \(paymentBusyId\)/)
  assert.match(collectPayment, /readStoredStripeAttempt\(id\)/)
  assert.match(collectPayment, /storedAttempt && storedAttempt\.amountCents === amount && storedAttempt\.currency === currency/)
  assert.match(collectPayment, /persistStripeAttempt\(id, \{ attemptId: activeAttemptId, idempotencyKey, amountCents: amount, currency, clientSecret \}\)/)
  assert.match(collectPayment, /fetchStripePaymentAttempt\(storedAttempt\.attemptId, authToken\)/)
  assert.match(collectPayment, /clearStoredStripeAttempt\(id\)[\s\S]*storedAttempt = null/)
  assert.match(collectPayment, /cancelStripePaymentAttempt\(activeAttemptId, authToken\)/)
})

test('API wrappers cover create status verify and cancel without Stripe secrets in frontend', () => {
  assert.match(apiSource, /createStripePaymentAttempt/)
  assert.match(apiSource, /fetchStripePaymentAttempt/)
  assert.match(apiSource, /verifyStripePaymentAttempt/)
  assert.match(apiSource, /cancelStripePaymentAttempt/)
  assert.doesNotMatch(apiSource, /STRIPE_SECRET|whsec_|sk_live|PaymentIntentSecret/)
})

test('web without Android plugin remains unsupported before any attempt is created', () => {
  const collectPayment = sliceBetween(appSource, 'const collectPayment = (id: string, amountDollars: number)', 'const registerOfflinePayment')
  const webUnsupported = collectPayment.indexOf('if (!isNativeApp)')
  const configFetch = collectPayment.indexOf('fetchStripeTerminalConfig(authToken)')
  const attemptCreate = collectPayment.indexOf('createStripePaymentAttempt')

  assert.ok(webUnsupported > 0)
  assert.ok(webUnsupported < configFetch)
  assert.ok(webUnsupported < attemptCreate)
  assert.match(collectPayment.slice(webUnsupported, configFetch), /Use an offline payment method from Payments on web/)
})

test('Android plugin stays backward-compatible and can use a server-created client secret', () => {
  assert.match(androidPluginSource, /STRIPE_PAYMENT_PROTOCOL_VERSION = 2/)
  assert.match(androidPluginSource, /public void getCapabilities\(PluginCall call\)/)
  assert.match(androidPluginSource, /result\.put\("stripePaymentProtocolVersion", STRIPE_PAYMENT_PROTOCOL_VERSION\)/)
  assert.match(androidPluginSource, /result\.put\("supportsExternalClientSecret", true\)/)
  assert.match(androidPluginSource, /clientSecret = cleanOptional\(call\.getString\("clientSecret"\)\)/)
  assert.match(androidPluginSource, /if \(clientSecret != null\) \{[\s\S]*retrieveAndProcessPaymentIntent\(call, clientSecret, settled\)/)
  assert.match(androidPluginSource, /else \{[\s\S]*createPaymentIntent\(call, jobId, amount, currency, settled\)/)
  assert.match(androidPluginSource, /result\.put\("paymentIntentId", confirmedPaymentIntent\.getId\(\)\)/)
  assert.match(androidPluginSource, /result\.put\("status", String\.valueOf\(confirmedPaymentIntent\.getStatus\(\)\)\)/)
})

test('Android external client secret path does not create its own PaymentIntent or expose secrets', () => {
  const clientSecretPath = sliceBetween(androidPluginSource, 'if (clientSecret != null) {', '} else {')
  const legacyPath = sliceBetween(androidPluginSource, '} else {', '}\n        }, settled);')

  assert.match(clientSecretPath, /retrieveAndProcessPaymentIntent\(call, clientSecret, settled\)/)
  assert.doesNotMatch(clientSecretPath, /createPaymentIntent/)
  assert.match(legacyPath, /createPaymentIntent\(call, jobId, amount, currency, settled\)/)
  assert.doesNotMatch(androidPluginSource, /Log\.[a-z]+\([^)]*clientSecret/i)
})

test('Android payment call resolves or rejects once with structured terminal result', () => {
  assert.match(androidPluginSource, /AtomicBoolean settled = new AtomicBoolean\(false\)/)
  assert.match(androidPluginSource, /resolveOnce\(call, settled, result\)/)
  assert.match(androidPluginSource, /rejectOnce\(call, settled, terminalError\(exception\)\)/)
  assert.match(androidPluginSource, /settled\.compareAndSet\(false, true\)/)
  assert.match(androidPluginSource, /result\.put\("paymentIntentId", confirmedPaymentIntent\.getId\(\)\)/)
  assert.match(androidPluginSource, /result\.put\("status", String\.valueOf\(confirmedPaymentIntent\.getStatus\(\)\)\)/)
})

test('offline payments and fee behavior are untouched by the client integration', () => {
  assert.match(appSource, /createOfflinePayment\(id, payload, authToken\)/)
  assert.match(appSource, /no Stripe fee/)
  assert.match(workerSource, /offline[\s\S]{0,240}processing_fee_cents/)
  assert.doesNotMatch(appSource, /2\.7|0\.027|gross[-_ ]?up/i)
  assert.doesNotMatch(apiSource, /2\.7|0\.027|gross[-_ ]?up/i)
})
