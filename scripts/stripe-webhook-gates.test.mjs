import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true)
const names = ['stripeAccountDiagnostics', 'requireStripePaymentAttemptsEnabled', 'requireOwner', 'ApiHttpError']
const functions = ast.statements.filter(n => n.name && names.includes(n.name.text))
assert.equal(functions.length, names.length)
const code = ts.transpileModule(functions.map(n => n.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const route = source.slice(source.indexOf("if (url.pathname === '/api/stripe/diagnostics'"), source.indexOf("if (url.pathname === '/api/stripe/terminal/config'"))
function runtime(fetch, user = { role: 'owner' }) {
  const routeCode = ts.transpileModule(`async function route(request, env) { const url = new URL(request.url); ${route} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function('fetch', 'requireAuth', 'getSql', 'json', `${code}\n${routeCode}\nreturn {route, stripeAccountDiagnostics, requireStripePaymentAttemptsEnabled}`)(
    fetch, async () => { if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 }); return user },
    () => ({}), body => Response.json(body),
  )
}
test('creation requires exact true and reconciliation routes retain auth without creation gate', () => {
  const r = runtime(() => { throw Error('unexpected Stripe') })
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    assert.throws(() => r.requireStripePaymentAttemptsEnabled({ STRIPE_PAYMENT_ATTEMPTS_ENABLED: flag }), e => e.status === 503)
  }
  assert.doesNotThrow(() => r.requireStripePaymentAttemptsEnabled({ STRIPE_PAYMENT_ATTEMPTS_ENABLED: 'true' }))
  const routes = source.slice(source.indexOf('if (stripeAttemptMatch'), source.indexOf("if (url.pathname === '/api/stripe/webhook'"))
  assert.doesNotMatch(routes, /requireStripePaymentAttemptsEnabled/)
  assert.equal((routes.match(/await requireAuth\(/g) || []).length, 3)
  assert.equal((routes.match(/await requireStripePaymentAttemptAccess\(/g) || []).length, 3)
})
test('diagnostics only owner; unauthorized and technician never call Stripe', async () => {
  for (const [user, status] of [[null, 401], [{ role: 'technician' }, 403]]) {
    let calls = 0
    const r = runtime(async () => { calls++; throw Error('must not call') }, user)
    await assert.rejects(() => r.route(new Request('https://local.invalid/api/stripe/diagnostics'), {}), e => e.status === status)
    assert.equal(calls, 0)
  }
})
test('diagnostics returns only account mode and observed matching API version', async () => {
  for (const headers of [[], ['2026-01-28.clover', '2026-01-28.clover'], ['2026-01-28.clover', '2025-09-30.clover']]) {
    const calls = []
    const r = runtime(async (url, options) => {
      calls.push(url)
      assert.equal(options.method, 'GET')
      assert.equal(options.headers.Authorization, 'Bearer synthetic-only')
      const body = url.endsWith('/account') ? { id: 'acct_synthetic', email: 'not-returned' } : { livemode: false, available: [{ amount: 999 }] }
      return Response.json(body, { headers: headers[calls.length - 1] ? { 'stripe-version': headers[calls.length - 1] } : {} })
    })
    const response = await r.route(new Request('https://local.invalid/api/stripe/diagnostics'), { STRIPE_SECRET_KEY: 'synthetic-only' })
    assert.deepEqual(await response.json(), { accountId: 'acct_synthetic', livemode: false, apiVersion: headers[0] && headers[0] === headers[1] ? headers[0] : 'unknown' })
    assert.deepEqual(calls, ['https://api.stripe.com/v1/account', 'https://api.stripe.com/v1/balance'])
  }
})
test('diagnostics sanitizes upstream errors and malformed data', async () => {
  for (const fetch of [async () => { throw Error('sensitive') }, async () => Response.json({ secret: 'sensitive' }, { status: 403 }), async () => Response.json({})]) {
    await assert.rejects(() => runtime(fetch).stripeAccountDiagnostics({ STRIPE_SECRET_KEY: 'synthetic-only' }), e => e.status === 502 && !e.message.includes('sensitive'))
  }
})
