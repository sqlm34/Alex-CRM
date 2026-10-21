import assert from 'node:assert/strict'
import { test } from 'node:test'
import pg from 'pg'
import { buildReceptionistTestSchema } from './receptionist-test-schema.mjs'

test('test bootstrap reuses CRM DDL and refuses an existing jobs database', async () => {
  const client = new pg.Client({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 5432), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test' })
  await client.connect()
  try {
    const identity = (await client.query('select current_database() as db,current_user as username')).rows[0]
    assert.deepEqual(identity, { db: 'webhook_test', username: 'webhook_test' })
    await client.query(buildReceptionistTestSchema())
    assert.equal((await client.query('select count(*)::int as n from jobs')).rows[0].n, 0)
    assert.equal((await client.query('select settings from receptionist_settings')).rows[0].settings.enabled, false)
    for (const table of ['users', 'booking_sessions', 'booking_requests', 'availability_blocks', 'receptionist_callbacks']) {
      assert.equal((await client.query('select to_regclass($1) as name', [table])).rows[0].name, table)
    }
    await assert.rejects(client.query(buildReceptionistTestSchema()), /Refusing to initialize/)
    await client.query('rollback')
    assert.equal((await client.query('select count(*)::int as n from jobs')).rows[0].n, 0)
  } finally { await client.end() }
})
