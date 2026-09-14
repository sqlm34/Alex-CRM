import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

function extract(file, names, bindings) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const functions = source.statements.filter(node => node.name && names.includes(node.name.text))
  assert.equal(functions.length, names.length)
  const code = ts.transpile(functions.map(node => node.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(bindings), code + `; return { ${names.join(',')} }`)(...Object.values(bindings))
}
const money = value => Math.round(Number(value || 0) * 100) / 100
const frontend = extract('../src/App.tsx', ['jobPaymentsTotal', 'jobBalance', 'jobTotal'], {
  centsToMoney: value => value / 100, moneyToCents: value => Math.round(value * 100),
  normalizeMoneyInput: money, financeTotal: items => money(items.reduce((sum, item) => sum + item.amount, 0)),
})
const backend = extract('../worker/index.ts', ['paymentsTotal'], { normalizePayments: value => value || [], normalizeInvoiceValue: money })

test('Job 23 parts then labor keeps balance and independent successful history', () => {
  const job = { invoice: 389.10, financeItems: [{ amount: 231.30 }, { amount: 157.80 }], payments: [] }
  assert.equal(frontend.jobBalance(job), 389.10)
  job.payments.push({ id: 'parts', amount: 231.30, status: 'succeeded', method: 'Tap to Pay' })
  assert.equal(frontend.jobBalance(job), 157.80)
  job.payments.push({ id: 'labor', amount: 157.80, status: 'succeeded', method: 'Tap to Pay' })
  assert.equal(frontend.jobBalance(job), 0)
  assert.equal(job.payments.length, 2)
  job.financeItems.push({ amount: 50 })
  assert.equal(frontend.jobBalance(job), 50)
})

test('frontend and invoice backend exclude unsuccessful payments identically', () => {
  for (const status of ['failed', 'canceled', 'processing', 'requires_payment_method', 'voided', 'refunded']) {
    const payments = [{ amount: 10, status: 'succeeded' }, { amount: 99, status }]
    assert.equal(frontend.jobPaymentsTotal(payments), 10)
    assert.equal(backend.paymentsTotal(payments), 10)
  }
  assert.equal(frontend.jobPaymentsTotal([{ amount: 10 }]), 10)
})

test('ten partial transactions stay independent and accumulate in cents', () => {
  const payments = Array.from({ length: 10 }, (_, id) => ({ id, amount: 15.01, status: 'succeeded' }))
  assert.equal(frontend.jobPaymentsTotal(payments), 150.10)
  assert.equal(Math.round(backend.paymentsTotal(payments) * 100), 15010)
})
