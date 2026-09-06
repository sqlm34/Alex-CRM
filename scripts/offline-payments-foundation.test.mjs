import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../migrations/2026-09-06_add_offline_payments.sql', import.meta.url), 'utf8')

class ConcurrentPaymentLedger {
  constructor(balanceCents) {
    this.initialBalanceCents = balanceCents
    this.audit = []
    this.legacy = []
    this.queue = Promise.resolve()
  }

  balanceCents() {
    const paid = this.legacy
      .filter((payment) => payment.status !== 'voided')
      .reduce((sum, payment) => sum + payment.amountCents, 0)
    return Math.max(0, this.initialBalanceCents - paid)
  }

  create(input, options = {}) {
    const run = this.queue.then(async () => {
      const existing = this.audit.find((payment) => payment.idempotencyKey === input.idempotencyKey)
      if (existing) {
        const samePayload = existing.amountCents === input.amountCents
          && existing.method === input.method
          && existing.paymentDate === input.paymentDate
          && existing.reference === input.reference
          && existing.note === input.note
        if (!samePayload) {
          throw new Error('409 different payload')
        }
        return existing
      }
      if (options.failAuditInsert) throw new Error('audit insert failed')
      if (input.amountCents > this.balanceCents()) throw new Error('409 exceeds balance')

      const row = { ...input, id: `payment-${this.audit.length + 1}`, status: 'succeeded' }
      const nextAudit = [...this.audit, row]
      const nextLegacy = [...this.legacy.filter((payment) => payment.id !== row.id), row]
      if (options.failLegacyUpdate) throw new Error('legacy update failed')
      this.audit = nextAudit
      this.legacy = nextLegacy
      return row
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  void(id) {
    const payment = this.audit.find((row) => row.id === id)
    if (!payment || payment.status === 'voided') throw new Error('409')
    payment.status = 'voided'
    this.legacy = this.legacy.map((row) => (row.id === id ? { ...payment } : row))
  }
}

test('offline payments migration is additive, idempotent, and constrained', () => {
  assert.match(migration, /create table if not exists public\.offline_payments/i)
  assert.match(migration, /unique \(job_id, idempotency_key\)/i)
  assert.match(migration, /offline_payments_amount_positive check \(amount_cents > 0\)/i)
  assert.match(migration, /offline_payments_fee_zero check \(source <> 'offline' or processing_fee_cents = 0\)/i)
  assert.match(migration, /method in \([\s\S]*'cash'[\s\S]*'check'[\s\S]*'zelle'[\s\S]*'venmo'[\s\S]*'cash_app'[\s\S]*'bank_transfer'[\s\S]*'credit_offline'[\s\S]*'debit_offline'[\s\S]*'other'/i)
  assert.match(migration, /create trigger prevent_offline_payments_delete/i)
  assert.match(migration, /raise exception 'offline payments are audit records and cannot be deleted'/i)
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|alter table public\.jobs|update public\.jobs)\b/i)
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
  assert.match(workerSource, /cleanNullableText\(payload\.reference, 120\)/)
  assert.match(workerSource, /note: cleanNullableText\(payload\.note, 1000\)/)
  assert.match(workerSource, /Payment date must be today or earlier/)
  assert.match(workerSource, /America\/Indiana\/Indianapolis/)
  assert.doesNotMatch(workerSource, /paymentDate > new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/)
  assert.match(workerSource, /offlinePaymentMatchesInput/)
  assert.match(workerSource, /Payment request id was already used for a different payment/)
  assert.match(workerSource, /on conflict \(job_id, idempotency_key\)/i)
  assert.match(workerSource, /processing_fee_cents, source[\s\S]*\$9, 0, 'offline'/)
  assert.match(workerSource, /sql\.transaction\(\(tx\) => \[/)
  assert.match(workerSource, /for update of jobs/i)
  assert.match(workerSource, /isolationLevel: 'Serializable'/)
  assert.doesNotMatch(workerSource, /sql\.query\('begin'\)/i)
})

test('serializable payment transactions retry safely without changing idempotency', () => {
  assert.match(workerSource, /function isRetryableTransactionError/)
  assert.match(workerSource, /code === '40001' \|\| code === '40P01'/)
  assert.match(workerSource, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/)
  assert.match(workerSource, /await sleep\(25 \* attempt\)/)
  assert.match(workerSource, /Payment could not be saved safely\. Please retry\./)
  assert.match(workerSource, /runSerializablePaymentTransaction\(\(\) => sql\.transaction/)
  assert.match(workerSource, /where job_id = \$1 and idempotency_key = \$2/)
  assert.match(workerSource, /not exists \(\s*select 1 from offline_payments where job_id = \$1 and idempotency_key = \$9\s*\)/)
  assert.match(workerSource, /\$3 <= totals\.balance_cents/)
})

test('voided payments stay in audit trail and are excluded from paid totals', () => {
  assert.match(workerSource, /status = 'voided', voided_at = now\(\), voided_by = \$3, void_reason = \$4/)
  assert.match(workerSource, /Offline payment is already voided/)
  assert.match(workerSource, /where job_id = \$1 and id = \$2 and status <> 'voided'/)
  assert.match(workerSource, /payment\.value->>'id' <> target\.id::text/)
  assert.match(workerSource, /payment\.status === 'voided' \? sum : sum \+ normalizeInvoiceValue\(payment\.amount\)/)
  assert.match(appSource, /payment\.status === 'voided' \? sum : sum \+ moneyToCents\(payment\.amount\)/)
})

test('offline payment audit rows block physical job deletion before R2 cleanup', () => {
  const deleteRoute = workerSource.slice(
    workerSource.indexOf("if (jobMatch && request.method === 'DELETE')"),
    workerSource.indexOf('const deletedJob = rows[0] as JobPayload'),
  )
  assert.match(workerSource, /async function jobHasOfflinePaymentAuditRows/)
  assert.match(deleteRoute, /jobHasOfflinePaymentAuditRows\(sql, existingJob\.id\)/)
  assert.match(deleteRoute, /Orders with offline payment audit records cannot be deleted/)
  assert.match(deleteRoute, /isPostgresErrorCode\(error, '23503'\)/)
  assert.match(deleteRoute, /Order cannot be deleted because related financial audit records exist/)
  assert.ok(deleteRoute.indexOf('jobHasOfflinePaymentAuditRows') < deleteRoute.indexOf('delete from jobs'))
  assert.ok(deleteRoute.indexOf('delete from jobs') < deleteRoute.indexOf('retireJobAttachmentsForDeletedJob'))
})

test('offline payment compatibility updates avoid double counting and stay atomic', () => {
  assert.match(workerSource, /payment\.value->>'id' <> target\.id::text/)
  assert.match(workerSource, /jsonb_build_array\(payment_json\.value\)/)
  assert.match(workerSource, /where coalesce\(payment\.value->>'status', ''\) <> 'voided'/)
  assert.match(workerSource, /set payments = next_payments\.payments,\s*paid = item_totals\.total_cents > 0 and payment_totals\.paid_cents >= item_totals\.total_cents/)
  assert.match(workerSource, /const \[lockedRows, existingRows, insertedRows, updatedJobRows\] = await runSerializablePaymentTransaction/)
  assert.match(workerSource, /const \[lockedJobs, rows, updatedRows, updatedJobRows\] = await runSerializablePaymentTransaction/)
  assert.doesNotMatch(workerSource, /insert into offline_payments[\s\S]{0,1200}await sql\.query\(\s*`update jobs/)
  assert.doesNotMatch(workerSource, /return json\(normalizeJobForResponse\(updatedJob\), request, env, 201\)[\s\S]{0,200}commit/i)
})

test('offline payment concurrency model prevents duplicates overpay and partial commits', async () => {
  const sameKeyLedger = new ConcurrentPaymentLedger(10000)
  const sameKeyInput = {
    amountCents: 2500,
    method: 'cash',
    paymentDate: '2026-09-06',
    reference: '',
    note: '',
    idempotencyKey: 'same-key-123456',
  }
  const sameKeyResults = await Promise.all([
    sameKeyLedger.create(sameKeyInput),
    sameKeyLedger.create(sameKeyInput),
  ])
  assert.equal(sameKeyLedger.audit.length, 1)
  assert.equal(sameKeyLedger.legacy.length, 1)
  assert.equal(sameKeyResults[0].id, sameKeyResults[1].id)

  await assert.rejects(
    () => sameKeyLedger.create({ ...sameKeyInput, amountCents: 2600 }),
    /409 different payload/,
  )

  const overpayLedger = new ConcurrentPaymentLedger(5000)
  const overpayResults = await Promise.allSettled([
    overpayLedger.create({ ...sameKeyInput, amountCents: 4000, idempotencyKey: 'pay-a-123456' }),
    overpayLedger.create({ ...sameKeyInput, amountCents: 4000, idempotencyKey: 'pay-b-123456' }),
  ])
  assert.equal(overpayResults.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(overpayLedger.audit.length, 1)
  assert.equal(overpayLedger.legacy.length, 1)
  assert.ok(overpayLedger.balanceCents() >= 0)

  const doubleCountLedger = new ConcurrentPaymentLedger(5000)
  const payment = await doubleCountLedger.create({ ...sameKeyInput, amountCents: 2000, idempotencyKey: 'once-123456789' })
  assert.equal(doubleCountLedger.audit.length, 1)
  assert.equal(doubleCountLedger.legacy.length, 1)
  assert.equal(doubleCountLedger.balanceCents(), 3000)
  doubleCountLedger.void(payment.id)
  assert.equal(doubleCountLedger.balanceCents(), 5000)

  const failLegacyLedger = new ConcurrentPaymentLedger(10000)
  await assert.rejects(
    () => failLegacyLedger.create({ ...sameKeyInput, idempotencyKey: 'fail-legacy-123456' }, { failLegacyUpdate: true }),
    /legacy update failed/,
  )
  assert.equal(failLegacyLedger.audit.length, 0)
  assert.equal(failLegacyLedger.legacy.length, 0)

  const failAuditLedger = new ConcurrentPaymentLedger(10000)
  await assert.rejects(
    () => failAuditLedger.create({ ...sameKeyInput, idempotencyKey: 'fail-audit-123456' }, { failAuditInsert: true }),
    /audit insert failed/,
  )
  assert.equal(failAuditLedger.audit.length, 0)
  assert.equal(failAuditLedger.legacy.length, 0)
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
