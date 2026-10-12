import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const start = source.indexOf("      if (url.pathname === '/api/jobs' && request.method === 'POST')")
const end = source.indexOf("      if (url.pathname === '/api/push-tokens'", start)
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
class ApiHttpError extends Error { constructor(message, status) { super(message); this.status = status } }

async function run({ overlap = false, role = 'owner', existing = null } = {}) {
  const calls = []
  const job = { id: 'draft', customer: 'Caller', phone: '3175550199', address: 'Test', service_date: '2026-10-14', service_window: '9:00 AM - 11:00 AM', allow_overlap: overlap }
  const deps = {
    url: new URL('https://example.com/api/jobs'), request: { method: 'POST', json: async () => job }, env: {},
    ctx: { waitUntil: () => {} }, getSql: () => ({ query: async () => existing ? [existing] : [] }),
    ensureAuthTables: async () => {}, requireAuth: async () => ({ id: 'owner', role }),
    requireOwner: user => { if (user.role !== 'owner') throw new ApiHttpError('Forbidden', 403) },
    parseServiceWindows: value => [value], ensureAvailabilityBlocksTable: async () => {},
    requireAvailableBookingWindow: async () => { calls.push('check'); throw new ApiHttpError('Booked', 409) },
    saveJobDraft: async () => { calls.push('draft') }, removeJobDraft: async () => { calls.push('remove') },
    insertJob: async (_, payload) => { calls.push('insert'); return payload },
    normalizeJobForResponse: job => job, sendJobPush: async () => {}, ApiHttpError,
    json: (body, _request, _env, status = 200) => ({ body, status }),
  }
  const handler = new (Object.getPrototypeOf(async function () {}).constructor)(...Object.keys(deps), code)
  return { response: await handler(...Object.values(deps)), calls }
}

test('conflict preserves draft before returning 409', async () => {
  const { response, calls } = await run()
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'BOOKING_CONFLICT_DRAFT_SAVED')
  assert.deepEqual(calls, ['check', 'draft'])
})
test('only owner can explicitly override conflict', async () => {
  const { response, calls } = await run({ overlap: true })
  assert.equal(response.status, 201)
  assert.deepEqual(calls, ['insert', 'remove'])
  await assert.rejects(run({ overlap: true, role: 'technician' }), error => error.status === 403)
})
test('lost-response retry returns original without duplicate or push', async () => {
  const { response, calls } = await run({ existing: { id: 'draft', created_by_user_id: 'owner' } })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, ['remove'])
})
