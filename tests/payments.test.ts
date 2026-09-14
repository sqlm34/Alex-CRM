import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { financials } from '../shared/finance.ts'
import { preparePayment, completePayment, recoverPayment, appendRecordedPayment, ensurePaymentTables } from '../worker/payments.ts'
import { createInvoicePdf, sendInvoiceEmail } from '../worker/index.ts'

const items = [{ id: 'parts', label: 'Parts', amount: 231.30 }, { id: 'labor', label: 'Labor', amount: 157.80 }]

async function fixture() {
  const db = new PGlite()
  await db.exec(`create table jobs (id text primary key, invoice numeric not null, paid boolean not null default false,
    finance_items jsonb not null default '[]', payments jsonb not null default '[]');`)
  await db.query('insert into jobs (id, invoice, finance_items) values ($1, $2, $3)', ['23', 389.10, JSON.stringify(items)])
  const sql = {
    query(text: string, params: unknown[] = []) {
      return { text, params, then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return db.query(text, params).then((result) => resolve(result.rows), reject)
      } }
    },
    transaction(queries: { text: string; params: unknown[] }[]) {
      return db.transaction(async (tx) => {
        const results = []
        for (const query of queries) results.push((await tx.query(query.text, query.params)).rows)
        return results
      })
    },
  } as unknown as Parameters<typeof preparePayment>[0]
  const intents = new Map<string, any>()
  const keys = new Map<string, string>()
  const emails: any[] = []
  let lostResponse = false
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    if (path === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'test-email' })
    }
    assert.ok(path.startsWith('https://api.stripe.com/v1/payment_intents'))
    let intent: any
    if (path.endsWith('/payment_intents')) {
      const params = init!.body as URLSearchParams
      const key = (init!.headers as Record<string, string>)['Idempotency-Key']
      assert.ok(key)
      const id = keys.get(key) || `pi_test${intents.size + 1}`
      keys.set(key, id)
      intent = intents.get(id) || { id, client_secret: 'test-only', amount: Number(params.get('amount')), amount_received: 0,
        currency: 'usd', status: 'requires_payment_method', created: 1789400000,
        metadata: { job_id: params.get('metadata[job_id]') }, payment_method_types: ['card_present'] }
      intents.set(id, intent)
      if (lostResponse) { lostResponse = false; throw new Error('Simulated response lost') }
    } else {
      const id = new URL(path).pathname.split('/')[3]
      intent = intents.get(id)
      assert.ok(intent, 'known intent')
      if (path.endsWith('/cancel')) {
        if (intent.status === 'succeeded') return Response.json({ error: { message: 'Already paid' } }, { status: 400 })
        intent.status = 'canceled'
      }
    }
    return Response.json(intent)
  }
  const job = async () => (await db.query<any>("select * from jobs where id = '23'")).rows[0]
  const succeed = (id: string) => { const intent = intents.get(id); intent.status = 'succeeded'; intent.amount_received = intent.amount }
  return { db, sql, fetch, intents, emails, job, succeed, loseResponse: () => { lostResponse = true } }
}

test('real PostgreSQL SQL: two card payments, native compatibility, replay and reload', async (t) => {
  const f = await fixture()
  t.after(() => f.db.close())
  t.mock.method(globalThis, 'fetch', f.fetch)
  const requestId = crypto.randomUUID()
  const first = await preparePayment(f.sql, 'test-only', '23', { requestId, amount: 23130, currency: 'usd', itemIds: ['parts'], memo: 'Parts' })
  const native = await preparePayment(f.sql, 'test-only', '23', { amount: 23130, currency: 'usd' })
  assert.equal(native.id, first.id)
  f.succeed(first.id)
  await completePayment(f.sql, 'test-only', '23', first.id)
  await completePayment(f.sql, 'test-only', '23', first.id)
  let job = await f.job()
  assert.equal(job.payments.length, 1)
  assert.equal(job.paid, false)
  assert.equal(financials(job.finance_items, job.payments).remaining, 15780)
  const original = structuredClone(job.payments[0])
  const second = await preparePayment(f.sql, 'test-only', '23', { requestId: crypto.randomUUID(), amount: 15780, currency: 'usd', itemIds: ['labor'], memo: 'Labor' })
  assert.notEqual(second.id, first.id)
  f.succeed(second.id)
  await completePayment(f.sql, 'test-only', '23', second.id)
  job = await f.job()
  assert.equal(job.paid, true)
  assert.equal(job.payments.length, 2)
  assert.deepEqual(job.payments[0], original)
  assert.equal(financials(job.finance_items, job.payments).remaining, 0)
  await assert.rejects(() => preparePayment(f.sql, 'test-only', '23', { requestId: crypto.randomUUID(), amount: 50, currency: 'usd' }), /remaining balance/)
})

test('lost Stripe response reuses persistent idempotency key; active attempts block other charges', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  const input = { requestId: crypto.randomUUID(), amount: 7500, currency: 'usd' }
  f.loseResponse()
  await assert.rejects(() => preparePayment(f.sql, 'test-only', '23', input), /response lost/)
  const intent = await preparePayment(f.sql, 'test-only', '23', input)
  assert.equal(f.intents.size, 1)
  await assert.rejects(() => preparePayment(f.sql, 'test-only', '23', { ...input, requestId: crypto.randomUUID() }), /already in progress/)
  f.succeed(intent.id)
  const recovered = await recoverPayment(f.sql, 'test-only', '23')
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.job.payments!.length, 1)
})

test('new labor item after a fully paid parts invoice allows another real payment record', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  await f.db.query('update jobs set invoice = 231.30, finance_items = $1 where id = $2', [JSON.stringify([items[0]]), '23'])
  const first = await preparePayment(f.sql, 'test-only', '23', { amount: 23130, currency: 'usd' })
  f.succeed(first.id)
  await completePayment(f.sql, 'test-only', '23', first.id)
  const original = structuredClone((await f.job()).payments[0])
  await f.db.query('update jobs set invoice = 389.10, finance_items = $1 where id = $2', [JSON.stringify(items), '23'])
  const second = await preparePayment(f.sql, 'test-only', '23', { amount: 15780, currency: 'usd' })
  f.succeed(second.id)
  await completePayment(f.sql, 'test-only', '23', second.id)
  const saved = await f.job()
  assert.deepEqual(saved.payments[0], original)
  assert.equal(saved.payments.length, 2)
  assert.equal(saved.paid, true)
})

test('simultaneous payment requests reserve only one Stripe transaction', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  await ensurePaymentTables(f.sql)
  const attempts = await Promise.allSettled([1, 2].map(() => preparePayment(f.sql, 'test-only', '23', {
    requestId: crypto.randomUUID(), amount: 7500, currency: 'usd',
  })))
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
  assert.equal(f.intents.size, 1)
})

test('failed/canceled intents are not money; cross-job references rejected', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  const intent = await preparePayment(f.sql, 'test-only', '23', { amount: 7500, currency: 'usd' })
  await assert.rejects(() => completePayment(f.sql, 'test-only', '23', intent.id), /not confirmed/)
  assert.equal((await f.job()).payments.length, 0)
  assert.equal((await recoverPayment(f.sql, 'test-only', '23')).recovered, false)
  const second = await preparePayment(f.sql, 'test-only', '23', { amount: 7500, currency: 'usd' })
  f.succeed(second.id)
  await assert.rejects(() => completePayment(f.sql, 'test-only', 'other-job', second.id), /does not belong/)
})

test('manual payment retries append once, cannot overpay or overlap pending card', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  await ensurePaymentTables(f.sql)
  const payment = { id: crypto.randomUUID(), amount: 75, method: 'Manual', status: 'succeeded', createdAt: new Date().toISOString() }
  await appendRecordedPayment(f.sql, '23', payment, true)
  await appendRecordedPayment(f.sql, '23', payment, true)
  assert.equal((await f.job()).payments.length, 1)
  await assert.rejects(() => appendRecordedPayment(f.sql, '23', { ...payment, id: crypto.randomUUID(), amount: 400 }, true), /remaining balance/)
  await preparePayment(f.sql, 'test-only', '23', { amount: 7500, currency: 'usd' })
  await assert.rejects(() => appendRecordedPayment(f.sql, '23', { ...payment, id: crypto.randomUUID() }, true), /pending/)
})

test('legacy paid jobs retain opening balance after a new item; migration is repeatable', async (t) => {
  const f = await fixture(); t.after(() => f.db.close())
  await f.db.exec("update jobs set invoice = 231.30, paid = true where id = '23'")
  await ensurePaymentTables(f.sql)
  await ensurePaymentTables(f.sql)
  const job = await f.job()
  assert.equal(Number(job.legacy_paid_amount), 231.30)
  assert.equal(financials(job.finance_items, job.payments, job.invoice, job.legacy_paid_amount).remaining, 15780)
})

test('invoice before/after partial/final payment can be emailed repeatedly, with email added later', async (t) => {
  const f = await fixture(); t.after(() => f.db.close()); t.mock.method(globalThis, 'fetch', f.fetch)
  const base = { id: '23', customer: 'Leslie Mansard', phone: '555-555-0123', email: '', address: 'Test address',
    appliance: 'Washer', issue: 'Test', service_date: '2026-09-14', service_window: '1:00 PM - 3:00 PM',
    status: 'new' as const, lat: 0, lng: 0, invoice: 389.10, finance_items: items, payments: [], paid: false }
  const env = { DATABASE_URL: '', RESEND_API_KEY: 'test-only', INVOICE_FROM_EMAIL: 'test@example.com' }
  await assert.rejects(() => sendInvoiceEmail(env, base), /email/i)
  await sendInvoiceEmail(env, { ...base, email: 'test@example.com' })
  const intent = await preparePayment(f.sql, 'test-only', '23', { amount: 23130, currency: 'usd' })
  f.succeed(intent.id)
  await completePayment(f.sql, 'test-only', '23', intent.id)
  const partial = { ...base, ...await f.job(), email: 'test@example.com' }
  const raw = atob(createInvoicePdf(partial, '23'))
  assert.ok(raw.includes('157.80'))
  assert.ok(raw.includes('231.30'))
  assert.ok(raw.includes('PARTIALLY PAID'))
  await sendInvoiceEmail(env, partial)
  await sendInvoiceEmail(env, partial)
  const second = await preparePayment(f.sql, 'test-only', '23', { amount: 15780, currency: 'usd' })
  f.succeed(second.id)
  await completePayment(f.sql, 'test-only', '23', second.id)
  const final = { ...base, ...await f.job(), email: 'test@example.com' }
  await sendInvoiceEmail(env, final)
  await sendInvoiceEmail(env, final)
  assert.equal(f.emails.length, 5)
  assert.match(f.emails[1].html, /Balance: \$157.80/)
  assert.match(f.emails[4].html, /Balance: \$0.00/)
  assert.ok(atob(f.emails[4].attachments[0].content).includes('(PAID)'))
})

test('PDF paginates long payment history without dropping payments', () => {
  const payments = Array.from({ length: 30 }, (_, i) => ({ id: String(i), amount: 1, method: `Payment-${i}`, createdAt: '2026-09-14T12:00:00Z', status: 'succeeded' }))
  const pdf = atob(createInvoicePdf({ id: 'test', customer: 'Test', phone: '', email: '', address: '', appliance: '', issue: '', service_date: '2026-09-14', service_window: '', status: 'new', invoice: 30, paid: true, lat: 0, lng: 0, payments }))
  assert.ok(pdf.includes('(Payment-29)'))
  assert.match(pdf, /\/Count [2-9]/)
})
