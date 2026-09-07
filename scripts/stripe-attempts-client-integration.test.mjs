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
  const legacyBranch = sliceBetween(collectPayment, 'if (!config.paymentAttemptsEnabled)', 'return\\n        }'.replace(/\\n/g, '\n'))

  assert.match(legacyBranch, /StripeTerminal\.collectPayment\(\{[\s\S]*jobId: id,[\s\S]*amount,[\s\S]*currency,[\s\S]*locationId: config\.locationId/)
  assert.match(legacyBranch, /appendPayment\(job, amountDollars/)
  assert.match(legacyBranch, /syncJobPatch\(id, \{[\s\S]*payments: paidJob\.payments/)
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
  assert.match(androidPluginSource, /clientSecret = cleanOptional\(call\.getString\("clientSecret"\)\)/)
  assert.match(androidPluginSource, /if \(clientSecret != null\) \{[\s\S]*retrieveAndProcessPaymentIntent\(call, clientSecret\)/)
  assert.match(androidPluginSource, /else \{[\s\S]*createPaymentIntent\(call, jobId, amount, currency\)/)
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
