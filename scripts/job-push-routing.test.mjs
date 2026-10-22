import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const notifications = readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8')
const transpile = (s) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
test('only new Website orders select the custom MP3; every other push keeps its old channel', async () => {
  let message
  const exports={}
  new Function('exports',transpile(readFileSync(new URL('../shared/push-presentation.ts',import.meta.url),'utf8')))(exports)
  const send = new Function('fetch', 'jobPushPresentation', `${transpile(functionSource(worker, 'sendFirebaseMessage'))}; return sendFirebaseMessage`)(async (_url, options) => { message = JSON.parse(options.body).message; return { ok: true } },exports.jobPushPresentation)
  for (const [source, event, website] of [['website', 'created', true], ['website', 'assigned', false], [null, 'created', false], ['google', 'created', false], ['google_maps', 'created', false]]) {
    await send({ FIREBASE_PROJECT_ID: 'test' }, 'test', 'test', { job: { id: 'test', booking_source: source }, event, title: 'Test', body: 'Test' })
    assert.equal(message.android.notification.channel_id, website ? 'alex-website-orders-v1' : 'alex-new-orders-v5')
    assert.equal(message.android.notification.sound, website ? 'website_order' : 'nice_melodic_sound')
    assert.equal(message.data.bookingSource, source || '')
  }
})
function functionSource(source, name) {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true)
  return ast.statements.find(n => n.name?.text === name).getText(ast).replace(/^export /, '')
}

test('new job recipients are owners plus only the assigned technician; assignment excludes owners', async () => {
  const delivered = []
  const users = [
    { role: 'owner', id: 'owner', token: 'owner-phone' },
    { role: 'technician', id: 'tech-a', token: 'a-phone' },
    { role: 'technician', id: 'tech-b', token: 'b-phone' },
  ]
  const sql = { query: async (query, [assignee, event]) => {
    assert.match(query, /select distinct push_tokens.token/)
    assert.match(query, /\(\$2::text = 'created' and users.role = 'owner'\)/)
    assert.match(query, /\(users.role = 'technician' and push_tokens.user_id = \$1::text\)/)
    return users.filter(u => (event === 'created' && u.role === 'owner') || (u.role === 'technician' && u.id === assignee))
  } }
  const send = new Function('getSql', 'ensureAuthTables', 'ensurePushTokensTable', 'getFirebaseAccessToken', 'sendFirebaseMessage', `${transpile(functionSource(worker, 'sendJobPush'))}; return sendJobPush`)(
    () => sql, async () => {}, async () => {}, async () => 'synthetic',
    async (_env, _access, token) => { delivered.push(token); return { ok: true } },
  )
  const env = { FIREBASE_PROJECT_ID: 'fixture', FIREBASE_CLIENT_EMAIL: 'fixture', FIREBASE_PRIVATE_KEY: 'fixture' }
  for (const [event, assignee, expected] of [
    ['created', null, ['owner-phone']],
    ['created', 'owner', ['owner-phone']],
    ['created', 'tech-a', ['owner-phone', 'a-phone']],
    ['assigned', 'tech-b', ['b-phone']],
    ['assigned', null, []],
  ]) {
    delivered.length = 0
    await send(env, { event, job: { created_by_user_id: assignee }, title: 'fixture', body: 'fixture' })
    assert.deepEqual(delivered, expected)
  }
})

test('PATCH only notifies a newly assigned technician, never normal saves or unassignment', async () => {
  const start = worker.indexOf('if (patch.created_by_user_id !== undefined &&')
  assert.ok(start > 0)
  const end = worker.indexOf('return json(normalizeJobForResponse(updatedJob', start)
  const invoke = new Function('patch', 'existingJob', 'updatedJob', 'ctx', 'env', 'sendJobPush', transpile(worker.slice(start, end)))
  for (const [patch, previous, next, count] of [
    [{ status: 'done' }, 'tech-a', 'tech-a', 0],
    [{ finance_items: [] }, 'tech-a', 'tech-a', 0],
    [{ created_by_user_id: 'tech-a' }, 'tech-a', 'tech-a', 0],
    [{ created_by_user_id: null }, 'tech-a', null, 0],
    [{ created_by_user_id: 'tech-a' }, null, 'tech-a', 1],
    [{ created_by_user_id: 'tech-b' }, 'tech-a', 'tech-b', 1],
  ]) {
    const pushes = [], pending = []
    invoke(patch, { created_by_user_id: previous }, { created_by_user_id: next }, { waitUntil: p => pending.push(p) }, {}, async (_env, push) => pushes.push(push))
    await Promise.all(pending)
    assert.equal(pushes.length, count)
    if (count) { assert.equal(pushes[0].event, 'assigned'); assert.equal(pushes[0].job.created_by_user_id, next) }
  }
})

test('creation keeps pushes and deletion no longer sends one', () => {
  // Manual/website creation plus the receptionist booking outbox.
  assert.equal((worker.match(/event: 'created',/g) || []).length, 3)
  assert.doesNotMatch(worker, /event: '(updated|deleted)',/)
  const start = worker.indexOf("if (jobMatch && request.method === 'DELETE')")
  const end = worker.indexOf('return json({ ok: true }', start)
  assert.doesNotMatch(worker.slice(start, end), /sendJobPush/)
  assert.match(worker.slice(start, end), /retireJobAttachmentsForDeletedJob/)
})

test('mobile polling never alerts; web polling and foreground FCM remain available', async () => {
  for (const native of [true, false]) {
    let alerts = 0
    const notify = new Function('Capacitor', 'playOrderChime', 'showWebNotification', `${transpile(functionSource(notifications, 'notifyNewOrder'))}; return notifyNewOrder`)(
      { isNativePlatform: () => native }, () => alerts++, () => alerts++,
    )
    await notify({ id: 'fixture' })
    assert.equal(alerts, native ? 0 : 2)
  }
  assert.doesNotMatch(notifications, /LocalNotifications\.schedule|showNativePushNotification/)
})

test('callback push taps retain their ID and survive cold-start subscription', async () => {
  const window = new EventTarget()
  const run = new Function('window', `${transpile(`let pendingOpenedPush; const pushSubscribers = new Set(); const pushSyncEventName = 'alex-push-sync';` + functionSource(notifications, 'dispatchOpenedPush') + functionSource(notifications, 'onPushSync'))}; return { dispatchOpenedPush, onPushSync }`)(window)
  const events = []
  run.dispatchOpenedPush({ event: 'receptionist_callback', call_id: 'synthetic-call' })
  const unsubscribe = run.onPushSync(detail => events.push(detail))
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(events, [{ event: 'receptionist_callback', call_id: 'synthetic-call', opened: true }])
  run.dispatchOpenedPush({ event: 'receptionist_callback', call_id: 'another-call' })
  assert.equal(events.length, 2)
  unsubscribe()
  const later = []
  run.onPushSync(detail => later.push(detail))
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(later.length, 0)
  assert.match(notifications, /localNotificationActionPerformed/)
})

test('foreground FCM refreshes every event without a second native alert or sound', async () => {
  const listeners = new Map(), events = []
  const run = new Function('PushNotifications', 'LocalNotifications', 'window', 'CustomEvent', `${transpile(`let pushListenersReady=false; const pushSyncEventName='sync';` + functionSource(notifications, 'prepareFirebasePush'))}; return prepareFirebasePush`)(
    { addListener: async (name, listener) => listeners.set(name, listener), checkPermissions: async () => ({ receive: 'granted' }), register: async () => {} },
    { addListener: async () => {}, schedule: () => { throw Error('Duplicate local alert') } },
    { dispatchEvent: event => events.push(event.detail) }, CustomEvent,
  )
  await run(); await run()
  for (const event of ['created', 'assigned', 'receptionist_call', 'receptionist_callback']) {
    const data = { event, jobId: 'test', call_id: 'call-test' }
    listeners.get('pushNotificationReceived')({ data, title: 'Test', body: 'Test' })
    assert.deepEqual(events.at(-1), data)
  }
  assert.equal(events.length, 4)
})
