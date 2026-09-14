import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function load(file, name) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const node = source.statements.find(node => node.name?.text === name)
  assert.ok(node)
  return new Function(ts.transpile(node.getText(source), { target: ts.ScriptTarget.ES2022 }) + `;return ${name}`)()
}
test('PDF and app show actual Indianapolis timestamp including year and DST', () => {
  for (const format of [load('../src/App.tsx', 'formatPaymentDate'), load('../worker/index.ts', 'formatInvoicePaymentDate')]) {
    assert.match(format('2026-09-14T19:37:00.000Z'), /2026.*3:37 PM/)
    assert.match(format('2026-01-14T19:37:00.000Z'), /2026.*2:37 PM/)
  }
})
test('historical offline display uses audit registration timestamp without changing card history or amounts', async () => {
  const restore = load('../worker/index.ts', 'restoreOfflinePaymentTimes')
  const job = { id: 'synthetic', payments: [
    { id: 'cash', source: 'offline', amount: 25, createdAt: '2026-09-14T12:00:00.000Z' },
    { id: 'card', source: 'stripe_terminal', amount: 35, createdAt: '2026-09-14T17:10:00.000Z' },
  ] }
  await restore({ query: async (sql, params) => {
    assert.match(sql, /^select /)
    assert.deepEqual(params, ['synthetic'])
    return [{ id: 'cash', created_at: '2026-09-14T19:37:00.000Z' }]
  } }, job)
  assert.equal(job.payments[0].createdAt, '2026-09-14T19:37:00.000Z')
  assert.equal(job.payments[0].amount, 25)
  assert.equal(job.payments[1].createdAt, '2026-09-14T17:10:00.000Z')
})
test('offline SQL does not manufacture noon timestamps', () => {
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  assert.ok(!worker.includes("|| 'T12:00:00.000Z'"))
  assert.equal((worker.match(/target.created_at at time zone 'UTC'/g) || []).length, 2)
})
