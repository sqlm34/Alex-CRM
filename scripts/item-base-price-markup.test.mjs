import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const pricingJs = ts.transpileModule(source('../src/itemPricing.ts'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText
const pricing = await import(`data:text/javascript;base64,${Buffer.from(pricingJs).toString('base64')}`)
const { itemPricingVersion, salePriceFromBase, prepareItemPricing } = pricing
const worker = source('../worker/index.ts')
const app = source('../src/App.tsx')

function actualFunctions(text, names, external = {}) {
  const ast = ts.createSourceFile('input.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  assert.equal(selected.length, names.length)
  const js = ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const dependencies = { ...pricing, maxFinanceCents: 99_999_999, maxFinanceQuantity: 9999.999, maxTaxRateBps: 10000, ...external }
  return new Function(...Object.keys(dependencies), `${js}; return { ${names.join(',')} };`)(...Object.values(dependencies))
}
const backend = actualFunctions(worker, ['moneyToCents', 'centsToMoney', 'normalizeQuantity',
  'calculateFinanceItemCents', 'clampFinanceCents', 'normalizeFinanceItems'], { cleanFinanceId: (id) => id })
const frontend = actualFunctions(app, ['moneyToCents', 'centsToMoney', 'normalizeQuantityInput',
  'calculateFinanceItemCents', 'clampFinanceCents', 'normalizeFinanceItemForSave'], { createFinanceId: () => 'generated' })
const save = (row, previous) => backend.normalizeFinanceItems([prepareItemPricing(row, previous)])[0]

test('integer unit markup is 5 percent plus 30 cents, not 5.30 percent', () => {
  for (const [base, sale] of [[10000, 10530], [20000, 21030], [5000, 5280], [0, 30], [10, 41]]) {
    assert.equal(salePriceFromBase(base), sale)
  }
  for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, pricing.maxBasePriceCents + 1]) {
    assert.throws(() => salePriceFromBase(invalid))
  }
  assert.ok(salePriceFromBase(pricing.maxBasePriceCents) <= pricing.maxSalePriceCents)
})

test('Worker ignores supplied sale/line total, applies quantity then discount then tax', () => {
  const item = save({ id: 'one', label: 'Labor', baseUnitPriceCents: 10000, unitPriceCents: 1,
    lineTotalCents: 1, quantity: 2, discountCents: 1000, taxable: true, taxRateBps: 700 })
  assert.equal(item.unitPriceCents, 10530)
  assert.equal(item.lineTotalCents, 21464)
  assert.equal(item.amount, 214.64)
  assert.equal(frontend.normalizeFinanceItemForSave(item).lineTotalCents, item.lineTotalCents)
  assert.equal(save({ ...item, quantity: 0.5, discountCents: 0, taxable: false }, item).lineTotalCents, 5265)
  const zero = save({ ...item, quantity: 0 }, item)
  assert.equal(zero.quantity, 0)
  assert.equal(zero.lineTotalCents, 0)
  assert.deepEqual(save(frontend.normalizeFinanceItemForSave(zero), zero), zero)
})

test('Save, reopen, polling and old-client echo do not compound markup', () => {
  let item = save({ id: 'one', label: 'Parts', baseUnitPriceCents: 20000, quantity: 1 })
  for (let i = 0; i < 10; i++) {
    item = save(frontend.normalizeFinanceItemForSave(JSON.parse(JSON.stringify(item))), item)
    assert.equal(item.unitPriceCents, 21030)
    assert.equal(item.baseUnitPriceCents, 20000)
  }
  const oldClient = { id: item.id, label: item.label, unitPriceCents: item.unitPriceCents, quantity: 1 }
  assert.deepEqual(save(oldClient, item), item)
  assert.equal(save({ ...item, baseUnitPriceCents: 5000 }, item).unitPriceCents, 5280)
})

test('legacy rows and invoice normalization never opt into markup implicitly', () => {
  for (const legacy of [{ id: 'legacy', label: 'Labor', amount: 200 },
    { id: 'expanded', label: 'Parts', amount: 100, quantity: 2, unitPriceCents: 5000 }]) {
    const expected = backend.normalizeFinanceItems([legacy])[0]
    assert.deepEqual(save(legacy, legacy), expected)
    assert.deepEqual(save(legacy), expected)
    assert.equal(expected.baseUnitPriceCents, undefined)
    assert.equal(expected.pricingVersion, undefined)
  }
  assert.match(worker, /const items = normalizeFinanceItems\(job.finance_items\)/)
  assert.match(worker, /patch.invoice = centsToMoney\(patch.finance_items.reduce/)
})

test('Price Book base remains unchanged; every payment method uses the same sale amount', () => {
  const catalog = { id: 'catalog', unitPriceCents: 10000 }
  for (const method of ['stripe', 'cash', 'check', 'zelle', 'venmo', 'cash_app', 'other']) {
    const item = save({ id: method, label: 'Service', priceBookItemId: catalog.id,
      baseUnitPriceCents: catalog.unitPriceCents, quantity: 1 })
    assert.equal(item.amount, 105.30)
    assert.equal(item.priceBookItemId, catalog.id)
  }
  assert.equal(catalog.unitPriceCents, 10000)
  assert.match(app, /baseUnitPriceCents: item.unitPriceCents/)
})

test('base price response is owner-only and sale price remains public to authorized job readers', () => {
  const response = actualFunctions(worker, ['normalizeJobForResponse'], {
    normalizeServiceDateValue: (value) => value, normalizeServiceWindowValue: (value) => value,
  }).normalizeJobForResponse
  const item = save({ id: 'one', label: 'Labor', baseUnitPriceCents: 10000 })
  const job = { finance_items: [item] }
  assert.equal(response(job).finance_items[0].baseUnitPriceCents, undefined)
  assert.equal(response(job).finance_items[0].unitPriceCents, 10530)
  assert.equal(response(job, true).finance_items[0].baseUnitPriceCents, 10000)
  assert.equal(job.finance_items[0].baseUnitPriceCents, 10000)
})

test('price editor saves only explicitly; draft survives rerender and Cancel performs no write', () => {
  const editor = source('../src/ItemBasePriceEditor.tsx')
  assert.match(editor, /onChange=\{\(event\) => setDraft\(event.target.value\)\}/)
  assert.match(editor, /onClick=\{\(\) => \{ onSave\(cents\); setDraft\(null\) \}\}/)
  assert.match(editor, /onClick=\{\(\) => setDraft\(null\)\}/)
  assert.match(editor, /cents === baseCents/)
  assert.doesNotMatch(editor, /useEffect|Stripe|payment|fetch\(/)
  assert.match(app, /key=\{`\$\{activeJob.id\}:\$\{item.id\}`\}/)
  assert.match(app, /pricingVersion: itemPricingVersion/)
  assert.equal(itemPricingVersion, 'base-plus-5-percent-30c-v1')
})
