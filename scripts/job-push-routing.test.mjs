import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const notifications = readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8')
const transpile = (s) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
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
  assert.equal((worker.match(/event: 'created',/g) || []).length, 2)
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
  assert.match(notifications, /showNativePushNotification\(notification.data/)
  assert.match(notifications, /event === 'assigned'/)
})
