import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../migrations/2026-09-06_add_offline_payments.sql', import.meta.url), 'utf8')

test('offline payments migration is additive, idempotent, and constrained', () => {
  assert.match(migration, /create table if not exists public\.offline_payments/i)
  assert.match(migration, /unique \(job_id, idempotency_key\)/i)
  assert.match(migration, /offline_payments_amount_positive check \(amount_cents > 0\)/i)
  assert.match(migration, /offline_payments_fee_zero check \(source <> 'offline' or processing_fee_cents = 0\)/i)
  assert.match(migration, /method in \([\s\S]*'cash'[\s\S]*'check'[\s\S]*'zelle'[\s\S]*'venmo'[\s\S]*'cash_app'[\s\S]*'bank_transfer'[\s\S]*'credit_offline'[\s\S]*'debit_offline'[\s\S]*'other'/i)
  assert.doesNotMatch(migration, /\b(drop|truncate|delete from|alter table public\.jobs|update public\.jobs)\b/i)
})

test('worker exposes offline create and void routes without Stripe calls', () => {
  assert.match(workerSource, /const offlinePaymentMatch = url\.pathname\.match\(\^?\/?\^?/)
  assert.match(workerSource, /payments\\\/offline/)
  assert.match(workerSource, /const voidOfflinePaymentMatch = url\.pathname\.match/)
  assert.match(workerSource, /payments\\\/\(\[\^\/\]\+\)\\\/void/)
  assert.match(workerSource, /function normalizeOfflinePaymentInput/)
  assert.match(workerSource, /requireOwner\(user\)[\s\S]*const jobId = decodeURIComponent\(voidOfflinePaymentMatch\[1\]\)/)

  const offlineRoute = workerSource.slice(
    workerSource.indexOf('const offlinePaymentMatch'),
    workerSource.indexOf('const jobMatch'),
  )
  assert.doesNotMatch(offlineRoute, /createStripe|StripeTerminal|payment-intent|PaymentIntent/i)
})

test('worker validates money, check reference, idempotency, and server balance', () => {
  assert.match(workerSource, /Number\.isSafeInteger\(amountCents\)/)
  assert.match(workerSource, /Payment amount cannot exceed balance/)
  assert.match(workerSource, /method === 'check' && !reference/)
  assert.match(workerSource, /on conflict \(job_id, idempotency_key\)/i)
  assert.match(workerSource, /processing_fee_cents, source[\s\S]*\$10, 0, 'offline'/)
  assert.match(workerSource, /jobPaidFromPayments\(currentJob, payments\)/)
})

test('voided payments stay in audit trail and are excluded from paid totals', () => {
  assert.match(workerSource, /status = 'voided', voided_at = now\(\), voided_by = \$3, void_reason = \$4/)
  assert.match(workerSource, /Offline payment is already voided/)
  assert.match(workerSource, /payment\.status === 'voided' \? sum : sum \+ normalizeInvoiceValue\(payment\.amount\)/)
  assert.match(appSource, /payment\.status === 'voided' \? sum : sum \+ moneyToCents\(payment\.amount\)/)
})

test('api client uses dedicated offline endpoints', () => {
  assert.match(apiSource, /export async function createOfflinePayment/)
  assert.match(apiSource, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/payments\/offline/)
  assert.match(apiSource, /export async function voidOfflinePayment/)
  assert.match(apiSource, /\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/payments\/\$\{encodeURIComponent\(paymentId\)\}\/void/)
})

test('frontend payment modal supports offline methods and preserves retry state', () => {
  assert.match(appSource, /const offlinePaymentMethods/)
  assert.match(appSource, /Add offline payment/)
  assert.match(appSource, /no Stripe fee/)
  assert.match(appSource, /setPaymentIdempotencyKey\(createPaymentIdempotencyKey\(\)\)/)
  assert.match(appSource, /if \(saved\) closePaymentDialog\(\)/)
  assert.match(appSource, /Check number is required/)
  assert.match(appSource, /paymentBusy \? 'Saving\.\.\.' : 'Save payment'/)
  assert.match(appSource, /createPortal\([\s\S]*offline-payment-modal[\s\S]*document\.body/)
})

test('price book, attachments, tap to pay, and lightweight jobs remain separated', () => {
  assert.match(appSource, /StripeTerminal\.collectPayment/)
  assert.match(appSource, /Tap to Pay is available in the Android app/)
  assert.match(workerSource, /type JobListPayload = Omit<JobPayload, 'finance_items' \| 'payments' \| 'model_photo_attachments' \| 'details' \| 'job_text'>/)
  assert.match(workerSource, /select \$\{listFields\}/)
  assert.doesNotMatch(appSource, /createOfflinePayment[\s\S]{0,200}StripeTerminal\.collectPayment/)
  assert.match(appSource, /AttachmentsScreen/)
})
