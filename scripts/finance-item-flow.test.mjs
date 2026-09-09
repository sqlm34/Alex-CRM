import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const panel = read('../src/FinanceItemsPanel.tsx')
const app = read('../src/App.tsx')
const css = read('../src/FinanceItemsPanel.css')

test('select and editor Save are local; only explicit job confirmation commits', () => {
  const choose = panel.slice(panel.indexOf('const choose ='), panel.indexOf('const commit ='))
  assert.match(choose, /setDraft\(normalizeItem/)
  assert.doesNotMatch(choose, /onCommit|fetch|onManageCatalog/)
  assert.match(panel, /onSave=\{item => \{ setDraft\(normalizeItem\(item\)\); setView\('detail'\) \}\}/)
  assert.match(panel, /if \(await commit\(next\) && alive.current\) close\(\)/)
  assert.match(app, /onFinanceItemsChange: .*Promise<boolean>/)
})

test('job confirmation waits for server and preserves draft on failure', () => {
  const update = app.slice(app.indexOf('const updateFinanceItems ='), app.indexOf('const savePriceBookItem ='))
  assert.ok(update.indexOf('setJobs(') > update.indexOf('.then((savedRow)'))
  assert.match(update, /if \(!savedRow\) throw/)
  assert.match(update, /return false/)
  assert.match(panel, /if \(alive.current && !saved\) setError/)
  assert.match(panel, /if \(busyRef.current \|\| disabled\) return false/)
  assert.match(panel, /busyRef.current = true/)
  assert.match(panel, /items.some\(item => item.id === draft.id\)/)
})

test('legacy draft edits only opt into pricing when base changes', () => {
  assert.match(panel, /const changedBase = fields.price !== initial.price && price !== base/)
  assert.match(panel, /changedBase \? \{ baseUnitPriceCents: price, pricingVersion: itemPricingVersion \} : \{\}/)
  assert.match(panel, /const \[fields, setFields\] = useState\(initial\)/)
  assert.match(panel, /<ItemEditor key=\{draft.id\}/)
  assert.doesNotMatch(panel, /setFields\(initial\)/)
})

test('catalog management is separate and owner-only', () => {
  assert.match(panel, /isOwner && <button[^>]*onClick=\{e => props.onManageCatalog\(null/)
  assert.match(panel, /isOwner && <div className="fi-catalog-actions">/)
  assert.match(panel, /item.active \|\| isOwner/)
  assert.doesNotMatch(panel, /createPriceBookItem|updatePriceBookItem|collectPayment|PaymentIntent|registerOfflinePayment/)
})

test('portal locks background and returns Back through the existing overlay contract', () => {
  assert.match(panel, /document.body\)/)
  assert.match(panel, /background.inert = true/)
  assert.match(panel, /background.inert = wasInert/)
  assert.match(panel, /backRef.current = back/)
  assert.match(app, /if \(itemFlowBackRef.current\?\.\(\)\) return true/)
  assert.match(panel, /window.visualViewport/)
  assert.match(css, /\.fi-scroll \{[^}]*overflow-y: auto/)
  assert.match(css, /\.fi-footer \{ flex-shrink: 0/)
})

test('opening Finance does not seed or save blank items; Due uses server-based Balance', () => {
  assert.doesNotMatch(app, /onFinanceItemsChange\(activeJob.id, defaultFinanceItems/)
  assert.match(app, /activeJob.invoice > 0 \? defaultFinanceItems\(activeJob.invoice\) : \[\]/)
  assert.match(app, /return invoice > 0 \? defaultFinanceItems\(invoice\) : \[\]/)
  assert.match(app, /due: financeSummary.balanceCents/)
  assert.match(panel, /<dt>Due<\/dt><dd>\{money\(props.summary.due\)\}/)
})
