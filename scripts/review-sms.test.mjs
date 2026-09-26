import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewSms } from '../src/reviewSms.ts'

test('review request uses the current customer first name and exact review link', () => {
  const result = reviewSms('  Maria Smith ', '(317) 555-0123')
  assert.equal(result.phone, '3175550123')
  assert.equal(result.text, 'Maria, I would really appreciate it if you would leave a review in my google business account. Thank you!!!\nhttps://g.page/r/CSFvvmB61pviEAE/review\nThank you in advance. Have a good day.')
  assert.ok(reviewSms('Bob Jones', '+13175550123').text.startsWith('Bob,'))
})

test('missing recipient data and phone URI injection are rejected without needing an address', () => {
  assert.throws(() => reviewSms('', '3175550123'))
  assert.throws(() => reviewSms('Maria', ''))
  assert.throws(() => reviewSms('Maria', '3175550123?body=other'))
})
