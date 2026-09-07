import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const offlineMigration = readFileSync(new URL('../migrations/2026-09-06_add_offline_payments.sql', import.meta.url), 'utf8')
const stripeMigration = readFileSync(new URL('../migrations/2026-09-07_add_stripe_payment_attempts.sql', import.meta.url), 'utf8')

class StripeAttemptLedger {
  constructor(balanceCents) {
    this.balanceCents = balanceCents
    this.attempts = []
    this.payments = []
  }

  create(input) {
    const existing = this.attempts.find((attempt) => attempt.idempotencyKey === input.idempotencyKey)
    if (existing) {
      if (existing.amountCents !== input.amountCents || existing.jobId !== input.jobId) {
        throw new Error('409 different payload')
      }
      return existing
    }
    if (this.attempts.some((attempt) => attempt.jobId === input.jobId && ['reserved', 'processing'].includes(attempt.status))) {
      throw new Error('409 active attempt')
    }
    if (input.amountCents > this.balanceCents) throw new Error('409 overpayment')
    const attempt = {
      ...input,
      id: `attempt-${this.attempts.length + 1}`,
      paymentIntentId: `pi_${this.attempts.length + 1}`,
      status: 'reserved',
    }
    this.attempts.push(attempt)
    return attempt
  }

  recordSucceeded(paymentIntentId, options = {}) {
    const attempt = this.attempts.find((row) => row.paymentIntentId === paymentIntentId)
    if (!attempt) throw new Error('404')
    if (this.payments.some((payment) => payment.paymentIntentId === paymentIntentId)) return attempt
    if (options.failLegacyWrite) throw new Error('legacy write failed')
    attempt.status = 'recorded'
    this.payments.push({
      amountCents: attempt.amountCents,
      paymentIntentId,
      feeCents: options.feeCents ?? 0,
    })
    this.balanceCents -= attempt.amountCents
    return attempt
  }
}

test('stripe payment attempts migration is additive audit storage', () => {
  assert.match(stripeMigration, /create table if not exists public\.stripe_payment_attempts/i)
  assert.match(stripeMigration, /id uuid primary key/i)
  assert.match(stripeMigration, /job_id text not null references public\.jobs\(id\) on delete restrict/i)
  assert.match(stripeMigration, /created_by text references public\.users\(id\) on delete set null/i)
  assert.match(stripeMigration, /idempotency_key text not null/i)
  assert.match(stripeMigration, /stripe_payment_intent_id text unique/i)
  assert.match(stripeMigration, /desired_net_cents integer not null/i)
  assert.match(stripeMigration, /charge_amount_cents integer not null/i)
  assert.match(stripeMigration, /expected_fee_cents integer/i)
  assert.match(stripeMigration, /actual_fee_cents integer/i)
  assert.match(stripeMigration, /actual_net_cents integer/i)
  assert.match(stripeMigration, /card_funding text/i)
  assert.match(stripeMigration, /charge_id text/i)
  assert.match(stripeMigration, /balance_transaction_id text/i)
  assert.match(stripeMigration, /failure_code text/i)
  assert.match(stripeMigration, /failure_message text/i)
  assert.match(stripeMigration, /unique \(job_id, idempotency_key\)/i)
  assert.match(stripeMigration, /stripe_payment_attempts_idempotency_key_unique/i)
  assert.match(stripeMigration, /stripe_payment_attempts_job_one_active_idx[\s\S]*where internal_status in/i)
  assert.match(stripeMigration, /prevent_stripe_payment_attempts_delete/i)
  assert.match(stripeMigration, /raise exception 'stripe payment attempts are audit records and cannot be deleted'/i)
  assert.doesNotMatch(stripeMigration, /\b(drop table|truncate|delete from|update public\.jobs|update jobs|insert into public\.jobs|insert into jobs)\b/i)
})

test('new Stripe attempts endpoints are disabled by default and do not replace existing Tap to Pay', () => {
  assert.match(workerSource, /STRIPE_PAYMENT_ATTEMPTS_ENABLED\?: string/)
  assert.match(workerSource, /function requireStripePaymentAttemptsEnabled/)
  assert.match(workerSource, /Stripe payment attempts are not enabled/)
  assert.match(workerSource, /\/api\/stripe\/terminal\/attempts/)
  assert.match(workerSource, /stripeAttemptVerifyMatch[\s\S]*\/verify/)
  assert.match(workerSource, /stripeAttemptCancelMatch[\s\S]*\/cancel/)
  assert.match(workerSource, /\/api\/stripe\/webhook/)

  const legacyRoute = workerSource.slice(
    workerSource.indexOf("if (url.pathname === '/api/stripe/terminal/payment-intent'"),
    workerSource.indexOf("if (url.pathname === '/api/stripe/terminal/attempts'"),
  )
  assert.match(legacyRoute, /createStripePaymentIntent\(env, job, user, amount, currency\)/)
  assert.doesNotMatch(legacyRoute, /STRIPE_PAYMENT_ATTEMPTS_ENABLED|stripe_payment_attempts/)
})

test('attempt creation reserves under DB lock before calling Stripe outside the transaction', () => {
  assert.match(workerSource, /async function reserveStripePaymentAttempt/)
  assert.match(workerSource, /for update of jobs/i)
  assert.match(workerSource, /isolationLevel: 'Serializable'/)
  assert.match(workerSource, /Payment amount cannot exceed balance/)
  assert.match(workerSource, /Another Stripe payment attempt is already active for this order/)
  assert.match(workerSource, /createOrReuseStripePaymentAttempt[\s\S]*reserveStripePaymentAttempt[\s\S]*createStripePaymentIntentForAttempt/)

  const createFlow = workerSource.slice(
    workerSource.indexOf('async function createOrReuseStripePaymentAttempt'),
    workerSource.indexOf('async function requireStripePaymentAttemptAccess'),
  )
  assert.ok(createFlow.indexOf('reserveStripePaymentAttempt') < createFlow.indexOf('createStripePaymentIntentForAttempt'))
  assert.doesNotMatch(createFlow.slice(0, createFlow.indexOf('createStripePaymentIntentForAttempt')), /stripePost|fetch\(`https:\/\/api\.stripe\.com/)
})

test('Stripe API creation uses Stripe idempotency key and avoids hardcoded fee/gross-up', () => {
  assert.match(workerSource, /createStripePaymentIntentForAttempt/)
  assert.match(workerSource, /'metadata\[payment_attempt_id\]': attempt\.id/)
  assert.match(workerSource, /Idempotency-Key/)
  assert.match(workerSource, /idempotencyKey: input\.idempotencyKey/)
  assert.doesNotMatch(workerSource, /2\.7|0\.027|10¢|\$0\.10|gross.?up|surcharge/i)
})

test('verification records only Stripe-succeeded payments and dedupes by PaymentIntent', () => {
  assert.match(workerSource, /async function verifyStripePaymentAttempt/)
  assert.match(workerSource, /intent\.status !== 'succeeded'/)
  assert.match(workerSource, /recordSucceededStripePaymentAttempt/)
  assert.match(workerSource, /retrieveStripePaymentIntent\(env, attempt\.stripe_payment_intent_id\)/)
  assert.match(workerSource, /coalesce\(payment\.value->>'paymentIntentId', ''\) <> \$2::text/)
  assert.match(workerSource, /processingFeeCents', coalesce\(target\.actual_fee_cents, 0\)/)
  assert.match(workerSource, /paymentIntentId', target\.stripe_payment_intent_id/)
  assert.match(workerSource, /status', 'succeeded'/)
  assert.match(workerSource, /actual_fee_cents = \$5::integer/)
  assert.match(workerSource, /actual_net_cents = \$6::integer/)
  assert.match(workerSource, /balance_transaction_id = \$4::text/)
})

test('actual fee, actual net, and card funding come from Charge and Balance Transaction', () => {
  assert.match(workerSource, /expand\[\]=latest_charge\.balance_transaction/)
  assert.match(workerSource, /stripePaymentDetailsFromIntent/)
  assert.match(workerSource, /balanceTransaction\?\.fee/)
  assert.match(workerSource, /balanceTransaction\?\.net/)
  assert.match(workerSource, /card_present/)
  assert.match(workerSource, /normalizeStripeCardFunding/)
  assert.match(workerSource, /credit', 'debit', 'prepaid/)
})

test('webhook foundation uses raw body signature verification and idempotent reconciliation', () => {
  assert.match(workerSource, /STRIPE_WEBHOOK_SECRET\?: string/)
  assert.match(workerSource, /async function handleStripeWebhook/)
  assert.match(workerSource, /const rawBody = await request\.text\(\)/)
  assert.match(workerSource, /verifyStripeWebhookSignature\(rawBody, signature, env\.STRIPE_WEBHOOK_SECRET\)/)
  assert.match(workerSource, /payment_intent\.succeeded/)
  assert.match(workerSource, /payment_intent\.payment_failed/)
  assert.match(workerSource, /payment_intent\.canceled/)
  assert.match(workerSource, /where stripe_payment_intent_id = \$1::text and internal_status <> 'recorded'/)
  assert.match(workerSource, /recordSucceededStripePaymentAttempt/)
})

test('attempt ledger model prevents active duplicates, overpay, retry duplication, and double count', () => {
  const ledger = new StripeAttemptLedger(8900)
  const first = ledger.create({ jobId: 'J-03', amountCents: 1, idempotencyKey: 'stripe-key-123456' })
  const retry = ledger.create({ jobId: 'J-03', amountCents: 1, idempotencyKey: 'stripe-key-123456' })
  assert.equal(first.id, retry.id)
  assert.throws(
    () => ledger.create({ jobId: 'J-03', amountCents: 2, idempotencyKey: 'stripe-key-123456' }),
    /409 different payload/,
  )
  assert.throws(
    () => ledger.create({ jobId: 'J-03', amountCents: 1, idempotencyKey: 'stripe-key-abcdef' }),
    /409 active attempt/,
  )

  ledger.recordSucceeded(first.paymentIntentId, { feeCents: 0 })
  ledger.recordSucceeded(first.paymentIntentId, { feeCents: 0 })
  assert.equal(ledger.payments.length, 1)
  assert.equal(ledger.balanceCents, 8899)

  const secondLedger = new StripeAttemptLedger(50)
  assert.throws(
    () => secondLedger.create({ jobId: 'J-99', amountCents: 51, idempotencyKey: 'stripe-key-overpay' }),
    /409 overpayment/,
  )

  const rollbackLedger = new StripeAttemptLedger(100)
  const rollbackAttempt = rollbackLedger.create({ jobId: 'J-88', amountCents: 50, idempotencyKey: 'stripe-key-rollback' })
  assert.throws(() => rollbackLedger.recordSucceeded(rollbackAttempt.paymentIntentId, { failLegacyWrite: true }), /legacy write failed/)
  assert.equal(rollbackLedger.payments.length, 0)
  assert.equal(rollbackLedger.balanceCents, 100)
})

test('offline payments remain isolated and fee is not applied outside Stripe Terminal attempts', () => {
  assert.match(offlineMigration, /offline_payments_fee_zero check \(source <> 'offline' or processing_fee_cents = 0\)/i)
  const offlineRoute = workerSource.slice(
    workerSource.indexOf('const offlinePaymentMatch'),
    workerSource.indexOf('const jobMatch'),
  )
  assert.doesNotMatch(offlineRoute, /stripe_payment_attempts|createStripePaymentIntentForAttempt|STRIPE_PAYMENT_ATTEMPTS_ENABLED/)
  assert.match(workerSource, /processing_fee_cents, source[\s\S]*0::integer, 'offline'::text/)
})
