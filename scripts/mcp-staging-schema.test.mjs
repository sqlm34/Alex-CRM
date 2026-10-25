import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { buildReceptionistTestSchema } from './receptionist-test-schema.mjs'

test('isolated MCP schema uses canonical CRM DDL and refuses existing jobs', async () => {
  const db = new PGlite()
  try {
    const sql = buildReceptionistTestSchema({ mcp: true })
    await db.exec(sql)
    const result = await db.query('select count(*)::int as count from jobs')
    assert.equal(result.rows[0].count, 0)
    for (const name of ['lat', 'lng']) {
      assert.equal((await db.query("select is_nullable from information_schema.columns where table_name='jobs' and column_name=$1", [name])).rows[0].is_nullable, 'YES')
    }
    for (const table of ['mcp_approvals', 'mcp_audit', 'booking_requests']) {
      assert.ok((await db.query('select to_regclass($1) as name', [table])).rows[0].name)
    }
    await assert.rejects(db.exec(sql), /Refusing to initialize an existing CRM database/)
    await db.exec('rollback')
    assert.equal((await db.query('select count(*)::int as count from jobs')).rows[0].count, 0)
  } finally { await db.close() }
})
