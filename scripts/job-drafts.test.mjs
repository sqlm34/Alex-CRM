import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

test('conflict drafts persist, update once, stay user-scoped and are removed after scheduling', async () => {
  const exports = {}
  const source = readFileSync(new URL('../worker/jobDrafts.ts', import.meta.url), 'utf8')
  new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports)
  const schema = `draft_test_${Date.now()}`
  const db = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.STRIPE_WEBHOOK_TEST_PORT || 55439), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', options: `-c search_path=${schema}` })
  const sql = { query: async (query, params) => (await db.query(query, params)).rows }
  try {
    await db.query(`create schema ${schema}`)
    await exports.saveJobDraft(sql, 'owner', { id: 'draft-1', customer: 'Caller', service_window: '9:00 AM - 11:00 AM' })
    await exports.saveJobDraft(sql, 'owner', { id: 'draft-1', customer: 'Caller', service_window: '1:00 PM - 3:00 PM' })
    assert.equal((await exports.listJobDrafts(sql, 'owner')).length, 1)
    assert.equal((await exports.listJobDrafts(sql, 'owner'))[0].service_window, '1:00 PM - 3:00 PM')
    assert.deepEqual(await exports.listJobDrafts(sql, 'other'), [])
    await exports.removeJobDraft(sql, 'other', 'draft-1')
    assert.equal((await exports.listJobDrafts(sql, 'owner')).length, 1)
    await exports.removeJobDraft(sql, 'owner', 'draft-1')
    assert.deepEqual(await exports.listJobDrafts(sql, 'owner'), [])
  } finally { await db.query(`drop schema if exists ${schema} cascade`); await db.end() }
})
