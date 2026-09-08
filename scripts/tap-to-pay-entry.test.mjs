import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const source = app.slice(app.indexOf('  const collectPayment ='), app.indexOf('  const registerOfflinePayment ='))
const executable = ts.transpile(source + '\nglobalThis.collect = collectPayment', { target: ts.ScriptTarget.ES2022 })

function harness({ native = true, enabled = true, protocol = 2, external = true, balance = 2, paid = false, configError = false, capabilityError = false } = {}) {
  const calls = []
  const job = { id: 'synthetic-job', paid, customer: 'Synthetic' }
  const context = {
    jobs: [job], requireFullJobDetails: () => true, jobBalance: () => balance,
    showToast: (toast) => calls.push(['toast', toast]), paymentBusyId: null,
    tapToPayBusyRef: { current: false }, isNativeApp: native,
    configuredApiUrl: 'https://synthetic.invalid', authToken: 'synthetic-session',
    setPaymentBusyId: (value) => calls.push(['busy', value]),
    fetchStripeTerminalConfig: async () => {
      calls.push(['config'])
      if (configError) throw new Error('Configuration unavailable')
      return { ready: true, locationId: 'synthetic-location', currency: 'usd', paymentAttemptsEnabled: enabled }
    },
    StripeTerminal: {
      getCapabilities: async () => {
        calls.push(['capabilities'])
        if (capabilityError) throw new Error('Plugin unavailable')
        return { stripePaymentProtocolVersion: protocol, supportsExternalClientSecret: external }
      },
      enableBluetooth: async () => { calls.push(['bluetooth']); return { enabled: true } },
      collectPayment: async () => { calls.push(['collect']); return { paymentIntentId: 'pi_synthetic' } },
    },
    readStoredStripeAttempt: () => null,
    createStripePaymentAttemptIdempotencyKey: () => 'synthetic-key',
    createStripePaymentAttempt: async () => {
      calls.push(['attempt'])
      return { attempt: { id: 'attempt_synthetic', paymentIntentId: 'pi_synthetic' }, clientSecret: 'synthetic-only' }
    },
    persistStripeAttempt: () => {}, clearStoredStripeAttempt: () => {},
    verifyStripePaymentAttempt: async () => {
      calls.push(['verify'])
      return { recorded: true, job, attempt: {} }
    },
    rowToJob: (value) => value, setJobs: () => {},
    fetchJobFromApi: async () => { calls.push(['fresh']); return job },
    formatMoney: (value) => `$${value.toFixed(2)}`, askToSendInvoice: () => {},
    errorMessage: (error) => error.message,
  }
  vm.runInNewContext(executable, context)
  return { calls, context, run: (amount = 2) => context.collect(job.id, amount, true) }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const names = (h) => h.calls.map(([name]) => name)

test('Tap to Pay entry stays inert until explicitly clicked and routes separately from offline', () => {
  const h = harness()
  assert.deepEqual(h.calls, [])
  assert.match(app, /onCollectTapToPay=\{\(id, amount\) => collectPayment\(id, amount, true\)\}/)
  assert.equal((app.match(/onClick=\{\(\) => onCollectTapToPay\(activeJob.id, balance\)\}/g) || []).length, 2)
  assert.equal((app.match(/'Add offline payment'/g) || []).length, 2)
  assert.match(app, /onClick=\{openPaymentDialog\}/)
})

test('web, false/missing/nonboolean flag, old or failing plugin cannot start any payment', async () => {
  for (const options of [{ native: false }, { enabled: false }, { enabled: 'true' }, { enabled: 'false' }, { enabled: null }, { protocol: 1 }, { external: false }, { capabilityError: true }, { configError: true }]) {
    const h = harness(options)
    h.run()
    await settle()
    assert.ok(!names(h).some((name) => ['bluetooth', 'collect', 'attempt', 'verify'].includes(name)))
    assert.ok(names(h).includes('toast'))
    assert.equal(h.context.tapToPayBusyRef.current, false)
  }
})

test('invalid, zero, paid and insufficient balance fail before network calls', async () => {
  for (const [options, amount] of [[{}, NaN], [{}, Infinity], [{}, -1], [{}, 0], [{}, 3], [{ balance: 0 }, 2], [{ paid: true }, 2]]) {
    const h = harness(options)
    h.run(amount)
    await settle()
    assert.ok(!names(h).includes('config'))
  }
})

test('double click starts one guarded server flow, verification precedes fresh job GET', async () => {
  const h = harness()
  h.run()
  h.run()
  await settle()
  assert.deepEqual(names(h).filter((name) => ['config', 'capabilities', 'bluetooth', 'attempt', 'collect', 'verify', 'fresh'].includes(name)),
    ['config', 'capabilities', 'bluetooth', 'attempt', 'collect', 'verify', 'fresh'])
  assert.equal(h.context.tapToPayBusyRef.current, false)
})
