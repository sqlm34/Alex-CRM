import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/stripe-dahlia-test-contract.json', import.meta.url)))
const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true)
const names = ['stripePost', 'stripeGet', 'createStripePaymentIntentForAttempt', 'createStripePaymentIntent',
  'retrieveStripePaymentIntent', 'cancelStripePaymentIntent', 'stripePaymentDetailsFromIntent',
  'normalizeStripeCardFunding', 'validateStripeIntentMatchesAttempt', 'requireStripeEnv', 'ApiHttpError']
const nodes = ast.statements.filter(n => names.includes(n.name?.text)
  || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === 'STRIPE_ATTEMPTS_API_VERSION'))
assert.equal(nodes.length, names.length + 1)
const code = ts.transpileModule(nodes.map(n => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const runtime = fetch => new Function('fetch', `${code};return {${names.join(',')}}`)(fetch)
const capture = name => structuredClone(fixture.captures.find(c => c.name === name).response)

test('new attempt requests pin observed version; legacy requests do not', async () => {
  const calls = []
  const r = runtime(async (url, options) => { calls.push({ url, ...options }); return Response.json(capture('credit-initial')) })
  const env = { STRIPE_SECRET_KEY: 'synthetic-key', STRIPE_TERMINAL_LOCATION_ID: 'tml_synthetic' }
  const job = { id: 'job-contract', customer: 'Synthetic', created_by_user_id: 'owner-contract' }
  await r.createStripePaymentIntentForAttempt(env, job, { id: 'owner-contract' }, { id: 'attempt-contract' }, { amountCents: 1000, currency: 'usd', idempotencyKey: 'same-key' })
  await r.retrieveStripePaymentIntent(env, 'pi_contract_1')
  await r.cancelStripePaymentIntent(env, 'pi_contract_1')
  for (const c of calls) assert.equal(c.headers['Stripe-Version'], fixture.provenance.responseApiVersion)
  assert.equal(calls[0].headers['Idempotency-Key'], 'same-key')
  assert.equal(calls[0].body.get('payment_method_types[]'), 'card_present')
  assert.equal(calls[0].body.get('capture_method'), 'automatic')
  assert.match(calls[1].url, /expand\[\]=latest_charge.balance_transaction/)
  await r.createStripePaymentIntent(env, job, { id: 'owner-contract' }, 1000, 'usd')
  await r.stripePost(env, '/v1/terminal/connection_tokens', new URLSearchParams())
  for (const c of calls.slice(3)) assert.equal(c.headers['Stripe-Version'], undefined)
})

test('real test-mode captures parse nullable, unexpanded and expanded Terminal details', () => {
  const r = runtime(() => { throw Error('No network in fixture tests') })
  assert.equal(fixture.provenance.livemode, false)
  assert.equal(fixture.captures.length, 15)
  for (const c of fixture.captures) assert.equal(c.response.livemode, false)
  for (const funding of ['credit', 'debit', 'prepaid']) {
    const initial = r.stripePaymentDetailsFromIntent(capture(`${funding}-initial`))
    assert.equal(initial.chargeId, null)
    assert.equal(initial.actualFeeCents, null)
    const unexpanded = r.stripePaymentDetailsFromIntent(capture(`${funding}-unexpanded`))
    assert.match(unexpanded.chargeId, /^ch_contract_/)
    assert.equal(unexpanded.actualFeeCents, null)
    const pi = capture(`${funding}-expanded`)
    const details = r.stripePaymentDetailsFromIntent(pi)
    assert.equal(details.cardFunding, funding)
    assert.equal(details.cardType, 'card_present')
    assert.equal(details.actualFeeCents, pi.latest_charge.balance_transaction.fee)
    assert.equal(details.actualNetCents, pi.latest_charge.balance_transaction.net)
    assert.equal(details.actualNetCents + details.actualFeeCents, pi.amount)
  }
  assert.equal(capture('declined-expanded').status, 'requires_payment_method')
  assert.equal(capture('canceled-expanded').status, 'canceled')
  assert.deepEqual([...new Set(fixture.events.map(e => e.type))].sort(), ['payment_intent.canceled', 'payment_intent.payment_failed', 'payment_intent.succeeded'])
  for (const e of fixture.events) { assert.equal(e.livemode, false); assert.equal(e.api_version, fixture.provenance.responseApiVersion) }
})

test('synthetic missing and delayed fields never become zero or a guessed funding type', () => {
  const r = runtime(() => { throw Error('No network') })
  for (const latest_charge of [undefined, null, 'ch_synthetic', { id: 'ch_synthetic', balance_transaction: 'txn_synthetic' }, { id: 'ch_synthetic', balance_transaction: null }]) {
    const d = r.stripePaymentDetailsFromIntent({ latest_charge })
    assert.equal(d.actualFeeCents, null); assert.equal(d.actualNetCents, null); assert.equal(d.cardFunding, 'unknown')
  }
  for (const fee of [null, undefined, '32', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const pi = capture('credit-expanded'); pi.latest_charge.balance_transaction.fee = fee
    assert.equal(r.stripePaymentDetailsFromIntent(pi).actualFeeCents, null)
  }
})

test('real metadata accepted only for the linked amount currency and intent', () => {
  const r = runtime(() => { throw Error('No network') })
  const pi = capture('credit-expanded')
  const attempt = { id: pi.metadata.payment_attempt_id, job_id: pi.metadata.job_id, stripe_payment_intent_id: pi.id, charge_amount_cents: pi.amount, currency: pi.currency }
  r.validateStripeIntentMatchesAttempt(pi, attempt)
  for (const patch of [{ id: 'pi_wrong' }, { amount: 1 }, { currency: 'eur' }, { metadata: { job_id: 'other' } }]) {
    assert.throws(() => r.validateStripeIntentMatchesAttempt({ ...pi, ...patch }, attempt), e => e.status === 409)
  }
})
