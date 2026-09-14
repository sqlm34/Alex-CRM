import { financials, paymentAllocation, validateAmount } from '../shared/finance.ts'
import type { FinanceLine, Payment } from '../shared/finance.ts'
import type { neon } from '@neondatabase/serverless'

type Sql = ReturnType<typeof neon<false, false>>
export type PaymentJob = { id: string; invoice: number; paid: boolean; legacy_paid_amount?: number; finance_items?: FinanceLine[]; payments?: Payment[] }
type Attempt = {
  request_id: string; job_id: string; amount: number; currency: string
  state: string; intent_id: string | null; details: { memo: string; itemAmounts: Record<string, number> }
  created_at: string
}
type Intent = {
  id: string; client_secret: string; status: string; amount: number; amount_received: number
  currency: string; created: number; metadata: { job_id?: string }; payment_method_types: string[]
  latest_charge?: { created: number } | string | null
}

export class PaymentError extends Error {
  status: number
  constructor(message: string, status = 409) { super(message); this.status = status }
}

export async function ensurePaymentTables(sql: Sql) {
  // Preserve pre-ledger paid orders without inventing historical Stripe transactions.
  await sql.query('alter table jobs add column if not exists legacy_paid_amount numeric(10,2)')
  await sql.query(`update jobs set legacy_paid_amount = case when paid and jsonb_array_length(payments) = 0 then invoice else 0 end where legacy_paid_amount is null`)
  await sql.query('alter table jobs alter column legacy_paid_amount set default 0')
  await sql.query(`create table if not exists payment_attempts (
    request_id text primary key, job_id text not null references jobs(id) on delete cascade,
    amount integer not null check (amount > 0), currency text not null,
    state text not null default 'active', intent_id text unique,
    details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
  )`)
  await sql.query(`create unique index if not exists payment_attempts_one_active_job
    on payment_attempts(job_id) where state = 'active'`)
}

export async function stripeRequest<T>(secret: string | undefined, path: string, body?: URLSearchParams, key?: string): Promise<T> {
  if (!secret) throw new PaymentError('Stripe is not configured.', 503)
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body,
  })
  const result = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new PaymentError(result.error?.message || 'Stripe request failed.', response.status >= 500 ? 502 : 409)
  return result
}

async function getJob(sql: Sql, id: string): Promise<PaymentJob> {
  const rows = await sql.query('select * from jobs where id = $1', [id])
  if (!rows[0]) throw new PaymentError('Job not found.', 404)
  return rows[0] as PaymentJob
}

async function ensureIntent(sql: Sql, secret: string | undefined, attempt: Attempt) {
  if (attempt.intent_id) return stripeRequest<Intent>(secret, `/payment_intents/${encodeURIComponent(attempt.intent_id)}?expand[]=latest_charge`)
  // Frozen parameters and the persisted key let a lost response be retried safely.
  if (Date.now() - new Date(attempt.created_at).getTime() > 23 * 60 * 60 * 1000) {
    throw new PaymentError('Unresolved payment attempt. Check Stripe before collecting another payment.')
  }
  const intent = await stripeRequest<Intent>(secret, '/payment_intents', new URLSearchParams({
    amount: String(attempt.amount), currency: attempt.currency, capture_method: 'automatic',
    'payment_method_types[]': 'card_present', 'metadata[job_id]': attempt.job_id,
    'metadata[crm_attempt_id]': attempt.request_id,
    description: `Alex Appliance Repair ${attempt.job_id}`,
  }), `crm-terminal-${attempt.request_id}`)
  await sql.query('update payment_attempts set intent_id = $1 where request_id = $2', [intent.id, attempt.request_id])
  return stripeRequest<Intent>(secret, `/payment_intents/${encodeURIComponent(intent.id)}?expand[]=latest_charge`)
}

export async function preparePayment(sql: Sql, secret: string | undefined, jobId: string, input: {
  requestId?: string; amount: number; currency: string; memo?: string; itemIds?: string[]
}) {
  await ensurePaymentTables(sql)
  // Installed Android shells still create/retrieve the intent through this endpoint.
  const legacy = !input.requestId
    ? await sql.query("select * from payment_attempts where job_id = $1 and state = 'active'", [jobId]) : []
  const requestId = input.requestId || (legacy[0] as Attempt | undefined)?.request_id || crypto.randomUUID()
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) throw new PaymentError('Invalid payment request.', 400)
  const existing = await sql.query('select * from payment_attempts where request_id = $1', [requestId])
  let attempt = existing[0] as Attempt | undefined
  if (attempt && (attempt.job_id !== jobId || attempt.amount !== input.amount || attempt.currency !== input.currency || attempt.state !== 'active')) {
    throw new PaymentError('This payment request has already been used or changed. Refresh the job.')
  }
  if (!attempt) {
    const job = await getJob(sql, jobId)
    let itemAmounts: Record<string, number>
    try {
      validateAmount(input.amount, financials(job.finance_items, job.payments, job.invoice, job.legacy_paid_amount).remaining, 50)
      itemAmounts = paymentAllocation(job.finance_items || [], job.payments || [], input.itemIds || [], input.amount)
    } catch (error) { throw new PaymentError((error as Error).message, 400) }
    const details = { memo: String(input.memo || '').slice(0, 200), itemAmounts }
    const [, rows] = await sql.transaction([
      sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [jobId]),
      sql.query(`insert into payment_attempts (request_id, job_id, amount, currency, details)
        select $1, id, $3, $4, $5::jsonb from jobs where id = $2
        and payments = $6::jsonb and finance_items = $7::jsonb and invoice = $8
        on conflict do nothing returning *`, [requestId, jobId, input.amount, input.currency,
        JSON.stringify(details), JSON.stringify(job.payments || []), JSON.stringify(job.finance_items || []), job.invoice]),
    ])
    attempt = rows[0] as Attempt | undefined
    if (!attempt) throw new PaymentError('A payment is already in progress or the balance changed. Refresh or check the pending payment.')
  }
  const intent = await ensureIntent(sql, secret, attempt)
  if (intent.status === 'succeeded') {
    await recordIntent(sql, jobId, intent, attempt.details)
    await sql.query("update payment_attempts set state = 'settled' where request_id = $1", [attempt.request_id])
    throw new PaymentError('This payment already succeeded. Refresh the job before collecting again.')
  }
  if (intent.status === 'canceled') throw new PaymentError('This payment was canceled. Check the pending payment and start again.')
  return { id: intent.id, clientSecret: intent.client_secret, amount: intent.amount, currency: intent.currency }
}

export async function appendRecordedPayment(sql: Sql, jobId: string, payment: Payment, checkBalance: boolean) {
  for (let retry = 0; retry < 5; retry++) {
    const job = await getJob(sql, jobId)
    const previous = job.payments || []
    const duplicate = previous.find((entry) => entry.id === payment.id || (payment.paymentIntentId && entry.paymentIntentId === payment.paymentIntentId))
    if (duplicate) {
      if (duplicate.amount !== payment.amount) throw new PaymentError('Payment reference already exists with another amount.')
      return job
    }
    if (checkBalance) {
      try { validateAmount(Math.round(payment.amount * 100), financials(job.finance_items, previous, job.invoice, job.legacy_paid_amount).remaining) }
      catch (error) { throw new PaymentError((error as Error).message, 400) }
    }
    const payments = [...previous, payment]
    const summary = financials(job.finance_items, payments, job.invoice, job.legacy_paid_amount)
    const [, rows] = await sql.transaction([
      sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [jobId]),
      sql.query(`update jobs set payments = $2::jsonb, paid = $3 where id = $1
        and payments = $4::jsonb and finance_items = $5::jsonb and invoice = $6
        ${checkBalance ? "and not exists (select 1 from payment_attempts where job_id = $1 and state = 'active')" : ''}
        returning *`, [jobId, JSON.stringify(payments), summary.status === 'Paid', JSON.stringify(previous), JSON.stringify(job.finance_items || []), job.invoice]),
    ])
    if (rows[0]) return rows[0] as PaymentJob
  }
  throw new PaymentError('Job is being updated or a card payment is pending. Refresh and retry saving this payment.')
}

export function verifiedPayment(jobId: string, intent: Intent, details?: Attempt['details']): Payment {
  if (intent.metadata.job_id !== jobId || !intent.payment_method_types.includes('card_present')) {
    throw new PaymentError('Stripe payment does not belong to this job.', 400)
  }
  if (intent.status !== 'succeeded' || intent.amount_received <= 0) throw new PaymentError('Stripe has not confirmed this payment.')
  return { id: intent.id, paymentIntentId: intent.id, amount: intent.amount_received / 100,
    createdAt: new Date((typeof intent.latest_charge === 'object' && intent.latest_charge ? intent.latest_charge.created : intent.created) * 1000).toISOString(), method: 'Tap to Pay', processor: 'Stripe', status: 'succeeded',
    memo: details?.memo, itemAmounts: details?.itemAmounts }
}

async function recordIntent(sql: Sql, jobId: string, intent: Intent, details?: Attempt['details']) {
  // Record received money even if an older client changed the invoice in flight.
  return appendRecordedPayment(sql, jobId, verifiedPayment(jobId, intent, details), false)
}

export async function completePayment(sql: Sql, secret: string | undefined, jobId: string, intentId: string, currency = 'usd') {
  await ensurePaymentTables(sql)
  if (!/^pi_[a-zA-Z0-9]+$/.test(intentId)) throw new PaymentError('Invalid Stripe payment reference.', 400)
  const intent = await stripeRequest<Intent>(secret, `/payment_intents/${intentId}?expand[]=latest_charge`)
  if (intent.currency !== currency) throw new PaymentError('Payment currency does not match the invoice.', 400)
  const rows = await sql.query('select * from payment_attempts where intent_id = $1 and job_id = $2', [intentId, jobId])
  const attempt = rows[0] as Attempt | undefined
  const job = await recordIntent(sql, jobId, intent, attempt?.details)
  await sql.query("update payment_attempts set state = 'settled' where intent_id = $1 and job_id = $2", [intentId, jobId])
  return job
}

export async function recoverPayment(sql: Sql, secret: string | undefined, jobId: string) {
  await ensurePaymentTables(sql)
  const rows = await sql.query("select * from payment_attempts where job_id = $1 and state = 'active'", [jobId])
  const attempt = rows[0] as Attempt | undefined
  if (!attempt) return { job: await getJob(sql, jobId), recovered: false }
  const intent = await ensureIntent(sql, secret, attempt)
  if (intent.status === 'succeeded') {
    return { job: await completePayment(sql, secret, jobId, intent.id, attempt.currency), recovered: true }
  }
  // A successful payment cannot be canceled. An ambiguous Stripe response keeps the lock.
  if (intent.status !== 'canceled') {
    await stripeRequest(secret, `/payment_intents/${intent.id}/cancel`, new URLSearchParams(), `crm-cancel-${attempt.request_id}`)
  }
  await sql.query("update payment_attempts set state = 'canceled' where request_id = $1", [attempt.request_id])
  return { job: await getJob(sql, jobId), recovered: false }
}
