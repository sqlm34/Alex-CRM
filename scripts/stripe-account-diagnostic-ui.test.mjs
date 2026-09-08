import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
const functions = ast.statements.filter(n => n.name && ['fetchStripeAccountDiagnostic', 'authHeaders'].includes(n.name.text))
assert.equal(functions.length, 2)
const code = ts.transpileModule(functions.map(n => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const wrapper = fetch => new Function('fetch', 'apiUrl', 'exports', `${code}; return fetchStripeAccountDiagnostic`)(fetch, 'https://api.example.invalid', {})

test('Stripe diagnostic wrapper is authenticated GET no-store with only three returned fields', async () => {
  const controller = new AbortController()
  let calls = 0
  const get = wrapper(async (url, options) => {
    calls++
    assert.equal(url, 'https://api.example.invalid/api/stripe/diagnostics')
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.headers.Authorization, 'Bearer synthetic-only')
    assert.equal(options.signal, controller.signal)
    return Response.json({ accountId: 'acct_synthetic', livemode: true, apiVersion: 'unknown', balance: 99, secret: 'not-returned' })
  })
  assert.deepEqual(await get('synthetic-only', controller.signal), { accountId: 'acct_synthetic', livemode: true, apiVersion: 'unknown' })
  assert.equal(calls, 1)
})
test('Stripe diagnostic wrapper handles test mode and unknown version safely', async () => {
  for (const version of ['2026-01-28.clover', 'untrusted-value', null]) {
    const get = wrapper(async () => Response.json({ accountId: 'acct_synthetic', livemode: false, apiVersion: version }))
    assert.deepEqual(await get('synthetic-only'), { accountId: 'acct_synthetic', livemode: false, apiVersion: version === '2026-01-28.clover' ? version : 'unknown' })
  }
})
test('Stripe diagnostic wrapper sanitizes auth/server errors and malformed responses', async () => {
  for (const [status, message] of [[401, 'Session expired. Please sign in again.'], [403, 'Only the owner can check the Stripe account.'], [500, 'Stripe account check is unavailable. Please try again.']]) {
    const get = wrapper(async () => Response.json({ error: 'private upstream message' }, { status }))
    await assert.rejects(() => get('synthetic-only'), e => e.message === message)
  }
  const get = wrapper(async () => Response.json({ accountId: 'acct_synthetic', livemode: 'true' }))
  await assert.rejects(() => get('synthetic-only'), /Invalid Stripe diagnostic response/)
})
test('Stripe diagnostic panel is manual owner-only and aborts on unmount', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../src/StripeAccountDiagnosticPanel.tsx', import.meta.url), 'utf8')
  assert.match(app, /isOwner \? \(\s*<>\s*<StripeCapabilitiesDiagnostic/)
  assert.match(app, /getAccountDiagnostic=\{\(signal\) => fetchStripeAccountDiagnostic\(auth.token, signal\)\}/)
  assert.match(panel, /onClick=\{\(\) => void check\(\)\}/)
  assert.match(panel, /if \(active.current\) return/)
  assert.match(panel, /active.current\?\.abort\(\)/)
  assert.match(panel, /if \(!controller.signal.aborted\) setResult/)
  assert.doesNotMatch(panel, /console\.|auth.token|clientSecret|PaymentIntent|connection.token|createStripePaymentAttempt/)
})
