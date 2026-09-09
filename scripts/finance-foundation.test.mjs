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
  return Math.min(99_999_999, Math.round(amount * 100))
}

function clampCents(value) {
  const cents = Math.round(Number(value || 0))
  if (!Number.isFinite(cents) || cents < 0) return 0
  return Math.min(99_999_999, cents)
}

function itemTotalCents(item) {
  const rawQuantity = Number(item.quantity ?? 1)
  const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0
    ? Math.min(9999.999, Math.round(rawQuantity * 1000) / 1000)
    : 0
  const unitPriceCents = clampCents(item.unitPriceCents ?? moneyToCents(item.amount))
  const discountCents = clampCents(item.discountCents || 0)
  const taxRateBps = Math.min(10000, Math.max(0, Number(item.taxRateBps || 0)))
  const subtotal = Math.min(99_999_999, Math.round(unitPriceCents * quantity))
  const taxableBase = Math.max(0, subtotal - Math.min(discountCents, subtotal))
  const taxCents = item.taxable ? Math.min(99_999_999, Math.round((taxableBase * taxRateBps) / 10000)) : 0
  return Math.min(99_999_999, taxableBase + taxCents)
}

test('finance cents calculation supports quantity discount tax and legacy amount', () => {
  assert.equal(itemTotalCents({ quantity: 2, unitPriceCents: 1250, discountCents: 500, taxable: true, taxRateBps: 700 }), 2140)
  assert.equal(itemTotalCents({ label: 'Legacy labor', amount: 189.99 }), 18999)
  assert.equal(itemTotalCents({ quantity: 1e20, unitPriceCents: 1e20, discountCents: -1, taxable: true, taxRateBps: 1e20 }), 99_999_999)
  assert.equal(itemTotalCents({ quantity: Number.POSITIVE_INFINITY, unitPriceCents: Number.NaN }), 0)
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
  assert.match(appSource, /Add offline payment/)
})

test('Price Book Add and Edit use one portal dialog instead of inline page flow', () => {
  assert.match(appSource, /import \{ createPortal \} from 'react-dom'/)
  assert.match(appSource, /const priceBookEditorModal = priceBookDraft && typeof document !== 'undefined'[\s\S]*createPortal\(/)
  assert.match(appSource, /document\.body/)
  assert.match(appSource, /onManageCatalog=\{\(item, opener\) => openPriceBookEditor\(item \|\| emptyPriceBookDraft\(\), opener\)\}/)
  const panel = readFileSync(new URL('../src/FinanceItemsPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /isOwner && <button[^>]+onClick=\{e => props.onManageCatalog\(null, e.currentTarget\)\}/)
  assert.match(panel, /onClick=\{e => props.onManageCatalog\(item, e.currentTarget\)\}/)
  assert.match(appSource, /aria-modal="true"[\s\S]*role="dialog"/)
  assert.doesNotMatch(appSource, /<section className="finance-section">[\s\S]*<form className="price-book-editor"/)
})

test('Price Book dialog supports focus close dirty confirm and double submit protection', () => {
  assert.match(appSource, /priceBookNameInputRef\.current\?\.focus\(\)/)
  assert.match(appSource, /priceBookOpenerRef\.current\?\.focus\(\)/)
  assert.match(appSource, /event\.key !== 'Escape'[\s\S]*closePriceBookEditor\(\)/)
  assert.match(appSource, /event\.target === event\.currentTarget[\s\S]*closePriceBookEditor\(\)/)
  assert.match(appSource, /window\.confirm\('Discard changes\?'\)/)
  assert.match(appSource, /if \(!priceBookDraft \|\| priceBookSaving\) return/)
  assert.match(appSource, /setPriceBookSaveError\('Unable to save price book item/)
  assert.match(appSource, /disabled=\{priceBookSaving\}/)
})

test('Price Book editor keeps focus stable while typing and preserves unit price text draft', () => {
  assert.match(appSource, /const priceBookDraftRef = useRef<PriceBookItem \| null>\(null\)/)
  assert.match(appSource, /priceBookDraftRef\.current = priceBookDraft/)
  assert.match(appSource, /const priceBookDraftId = priceBookDraft\?\.id \?\? ''/)
  assert.match(appSource, /window\.requestAnimationFrame\(\(\) => priceBookNameInputRef\.current\?\.focus\(\)\)[\s\S]*\}, \[priceBookDraftId\]\)/)
  assert.doesNotMatch(appSource, /requestAnimationFrame\(\(\) => priceBookNameInputRef\.current\?\.focus\(\)\)[\s\S]{0,900}\}, \[closePriceBookEditor, priceBookDraft\]\)/)
  assert.match(appSource, /unitPriceInput\?: string/)
  assert.match(appSource, /unitPriceInput: centsToMoney\(item\.unitPriceCents\)\.toFixed\(2\)/)
  assert.match(appSource, /value=\{priceBookDraft\.unitPriceInput \?\? ''\}/)
  assert.match(appSource, /onChange=\{\(event\) => setPriceBookDraft\(\(current\) => current \? \{ \.\.\.current, unitPriceInput: event\.target\.value \} : current\)\}/)
  assert.doesNotMatch(appSource, /value=\{centsToMoney\(priceBookDraft\.unitPriceCents\) \|\| ''\}/)
  assert.match(appSource, /const unitPrice = parsePriceBookUnitPriceInput\(priceBookDraft\.unitPriceInput\)/)
  assert.match(appSource, /unit_price_cents: unitPrice\.cents/)
})

test('Price Book API and migration are additive and owner-gated', () => {
  assert.match(migrationSource, /create table if not exists public\.price_book_items/)
  assert.match(migrationSource, /unit_price_cents integer not null default 0/)
  assert.match(migrationSource, /price_book_items_name_present/)
  assert.match(migrationSource, /unit_price_cents between 0 and 99999999/)
  assert.match(migrationSource, /add column if not exists/)
  assert.match(apiSource, /fetchPriceBookItems/)
  assert.match(apiSource, /createPriceBookItem/)
  assert.match(apiSource, /updatePriceBookItem/)
  assert.match(workerSource, /url\.pathname === '\/api\/price-book'/)
  assert.match(workerSource, /requireOwner\(user\)[\s\S]*normalizePriceBookInput/)
  assert.match(workerSource, /user\.role === 'owner'[\s\S]*where active = true/)
})

test('Worker recalculates item totals and does not trust frontend totals', () => {
  assert.match(workerSource, /function calculateFinanceItemCents/)
  assert.match(workerSource, /lineTotalCents: clampFinanceCents\(discountedCents \+ taxCents\)/)
  assert.match(workerSource, /amount: centsToMoney\(cents\.lineTotalCents\)/)
  assert.doesNotMatch(workerSource, /lineTotalCents:\s*row\.lineTotalCents/)
})

test('invoice PDF and email remain compatible with normalized finance items and payments', () => {
  assert.match(workerSource, /function createInvoicePdf/)
  assert.match(workerSource, /const items = normalizeFinanceItems\(job\.finance_items\)/)
  assert.match(workerSource, /const payments = normalizePayments\(job\.payments\)/)
  assert.match(workerSource, /function invoiceTotal\(job: JobPayload\)[\s\S]*normalizeFinanceItems\(job\.finance_items\)/)
})

test('lightweight jobs payload does not include heavy or Price Book data', () => {
  assert.match(workerSource, /type JobListPayload = Omit<JobPayload, 'finance_items' \| 'payments' \| 'model_photo_attachments' \| 'details' \| 'job_text'>/)
  assert.doesNotMatch(workerSource.match(/const listFields = `[\s\S]*?`/)?.[0] || '', /finance_items|payments|model_photo_attachments|price_book/)
})

test('F1 does not start Stripe fee or gross-up changes', () => {
  assert.doesNotMatch(appSource, /processing fee|gross-up|surcharge/i)
  assert.doesNotMatch(workerSource, /actualStripeFee|grossUp|surcharge/i)
})
