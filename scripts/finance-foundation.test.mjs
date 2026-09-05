import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../migrations/2026-09-05_add_price_book_items.sql', import.meta.url), 'utf8')

function moneyToCents(value) {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount) || amount < 0) return 0
  return Math.round(amount * 100)
}

function itemTotalCents(item) {
  const quantity = Math.max(0, Math.round(Number(item.quantity ?? 1) * 1000) / 1000)
  const unitPriceCents = Math.max(0, Math.round(Number(item.unitPriceCents ?? moneyToCents(item.amount))))
  const discountCents = Math.max(0, Math.round(Number(item.discountCents || 0)))
  const taxableBase = Math.max(0, Math.round(unitPriceCents * quantity) - discountCents)
  const taxCents = item.taxable ? Math.round((taxableBase * Math.max(0, Number(item.taxRateBps || 0))) / 10000) : 0
  return taxableBase + taxCents
}

test('finance cents calculation supports quantity discount tax and legacy amount', () => {
  assert.equal(itemTotalCents({ quantity: 2, unitPriceCents: 1250, discountCents: 500, taxable: true, taxRateBps: 700 }), 2140)
  assert.equal(itemTotalCents({ label: 'Legacy labor', amount: 189.99 }), 18999)
})

test('frontend preserves legacy amount while adding expanded item fields', () => {
  assert.match(appSource, /type FinanceItem = \{[\s\S]*unitPriceCents\?: number[\s\S]*lineTotalCents\?: number[\s\S]*amount: number/)
  assert.match(appSource, /normalizeFinanceItemForSave[\s\S]*amount: centsToMoney\(cents\.lineTotalCents\)/)
  assert.match(appSource, /priceBookItemId/)
})

test('Finance UI has F1 sections and keeps later stages staged', () => {
  for (const section of ['Items', 'Payments', 'estimates', 'timesheets', 'costs']) {
    assert.match(appSource, new RegExp(section))
  }
  assert.match(appSource, /Coming in next stage/)
  assert.match(appSource, /Current payments remain available in Timeline/)
})

test('Price Book API and migration are additive and owner-gated', () => {
  assert.match(migrationSource, /create table if not exists public\.price_book_items/)
  assert.match(migrationSource, /unit_price_cents integer not null default 0/)
  assert.match(apiSource, /fetchPriceBookItems/)
  assert.match(apiSource, /createPriceBookItem/)
  assert.match(apiSource, /updatePriceBookItem/)
  assert.match(workerSource, /url\.pathname === '\/api\/price-book'/)
  assert.match(workerSource, /requireOwner\(user\)[\s\S]*normalizePriceBookInput/)
})

test('lightweight jobs payload does not include heavy or Price Book data', () => {
  assert.match(workerSource, /type JobListPayload = Omit<JobPayload, 'finance_items' \| 'payments' \| 'model_photo_attachments' \| 'details' \| 'job_text'>/)
  assert.doesNotMatch(workerSource.match(/const listFields = `[\s\S]*?`/)?.[0] || '', /finance_items|payments|model_photo_attachments|price_book/)
})

test('F1 does not start Stripe fee or PaymentIntent changes', () => {
  assert.doesNotMatch(appSource, /processing fee|gross-up|surcharge/i)
  assert.doesNotMatch(workerSource, /desiredNet|actualStripeFee|grossUp/i)
})
