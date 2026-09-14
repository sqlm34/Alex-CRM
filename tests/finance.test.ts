import test from 'node:test'
import assert from 'node:assert/strict'
import { cents, financials, validateAmount, itemRemaining, paymentAllocation } from '../shared/finance.ts'
import type { Payment } from '../shared/finance.ts'

export const items = [{ id: 'parts', label: 'Parts', amount: 231.30 }, { id: 'labor', label: 'Labor', amount: 157.80 }]
const payment = (amount: number, status = 'succeeded', id = crypto.randomUUID()): Payment => ({ id, amount, status, method: 'Tap to Pay', createdAt: new Date().toISOString() })

test('Job #23: parts then labor, persistence and separate history', () => {
  const payments: Payment[] = []
  assert.deepEqual(financials(items, payments), { total: 38910, paid: 0, remaining: 38910, status: 'Unpaid' })
  payments.push(payment(231.30))
  assert.deepEqual(financials(items, payments), { total: 38910, paid: 23130, remaining: 15780, status: 'Partially Paid' })
  const reopened = JSON.parse(JSON.stringify({ items, payments }))
  assert.equal(financials(reopened.items, reopened.payments).remaining, 15780)
  payments.push(payment(157.80))
  assert.deepEqual(financials(items, payments), { total: 38910, paid: 38910, remaining: 0, status: 'Paid' })
  assert.equal(payments.length, 2)
})

test('three, four and ten separate payments', () => {
  for (const amounts of [[100, 50, 150], [200, 150, 100, 150], Array(10).fill(30)]) {
    const total = amounts.reduce((a, b) => a + b, 0)
    const lines = [{ id: 'service', label: 'Service', amount: total }]
    const payments: Payment[] = []
    amounts.forEach((value, index) => {
      validateAmount(cents(value), financials(lines, payments).remaining)
      payments.push(payment(value))
      assert.equal(financials(lines, payments).remaining > 0, index < amounts.length - 1)
    })
    assert.equal(financials(lines, payments).paid, cents(total))
  }
})

test('custom partial amount and amount validation', () => {
  const lines = [{ id: 'a', label: 'Work', amount: 300 }]
  assert.equal(financials(lines, [payment(75)]).remaining, 22500)
  for (const amount of [0, -1, NaN, Infinity, 30001, 0.5]) assert.throws(() => validateAmount(amount, 30000))
  assert.throws(() => validateAmount(1, 0))
  assert.throws(() => validateAmount(49, 30000, 50))
  assert.doesNotThrow(() => validateAmount(50, 30000, 50))
  assert.equal(cents('231.30') + cents('157.80'), 38910)
  for (const value of ['abc', '1.001', '-2', '1e3']) assert.ok(Number.isNaN(cents(value)))
})

test('failed/canceled/processing payments never count; legacy status remains supported', () => {
  const payments = ['failed', 'canceled', 'cancelled', 'processing', 'requires_capture'].map((status) => payment(100, status))
  assert.equal(financials(items, payments).paid, 0)
  assert.equal(financials(items, [payment(231.30, 'SUCCEEDED')]).paid, 23130)
  assert.equal(financials(items, [{ ...payment(231.30), status: undefined }]).paid, 23130)
})

test('new finance item reopens balance without changing successful history', () => {
  const payments = [payment(231.30)]
  const original = structuredClone(payments)
  assert.equal(financials([items[0]], payments).status, 'Paid')
  assert.equal(financials(items, payments).remaining, 15780)
  assert.deepEqual(payments, original)
  assert.equal(financials([{ ...items[0], amount: 0 }], payments, 231.30).total, 0)
})

test('explicit item allocations cannot be charged a second time', () => {
  const first = { ...payment(231.30), itemAmounts: paymentAllocation(items, [], ['parts'], 23130) }
  assert.equal(itemRemaining(items[0], [first]), 0)
  assert.equal(itemRemaining(items[1], [first]), 15780)
  assert.throws(() => paymentAllocation(items, [first], ['parts'], 23130))
  assert.throws(() => paymentAllocation(items, [], ['parts'], 10000))
  assert.deepEqual(paymentAllocation(items, [], [], 7500), {})
})

test('duplicate Stripe reference counts once, legacy paid balance survives adding items', () => {
  const first = { ...payment(231.30), paymentIntentId: 'pi_original' }
  assert.equal(financials(items, [first, { ...first, id: 'other' }]).paid, 23130)
  assert.equal(financials(items, [], 389.10, 231.30).remaining, 15780)
})
