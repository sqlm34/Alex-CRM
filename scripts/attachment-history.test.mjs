import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const start = source.indexOf("          if (attachment.upload_status === 'ready' && !attachment.deleted_at)", source.indexOf('      const attachmentMatch ='))
const end = source.indexOf('          const rows = (await sql.query(', start)
const archive = new Function('sql', 'attachment', 'attachmentId', 'publicAttachmentMetadata', 'json', 'request', 'env', `return (async()=>{${source.slice(start, end)}})()`)

test('archive retains ready object and receipt data, preserves first hidden timestamp on retries', async () => {
  const row = { id: 'photo', upload_status: 'ready', deleted_at: null, hidden_at: null, object_key: 'original-receipt' }
  const queries = []
  const sql = { query: async (query, values) => {
    queries.push(query)
    assert.deepEqual(values, ['photo'])
    assert.match(query, /hidden_at=coalesce\(hidden_at,now\(\)\)/)
    row.hidden_at ||= '2026-10-07T18:00:00Z'
    return [{ ...row }]
  } }
  for (let i = 0; i < 2; i++) {
    const result = await archive(sql, row, row.id, value => value, value => value, {}, {})
    assert.equal(result.attachment.hidden_at, '2026-10-07T18:00:00Z')
    assert.equal(result.attachment.object_key, 'original-receipt')
    assert.equal(result.attachment.upload_status, 'ready')
    assert.equal(result.attachment.deleted_at, null)
  }
  assert.equal(queries.length, 2)
  assert.doesNotMatch(queries.join('\n'), /update parts_receipts|set object_key|set upload_status|set deleted_at/i)
})

test('archive list and access retain job authorization and separate active files', () => {
  const route = source.slice(source.indexOf('      const attachmentMatch ='), source.indexOf('      const offlinePaymentMatch ='))
  assert.ok(route.indexOf('await requireJobAccess(') < route.indexOf("if (request.method === 'DELETE')"))
  assert.ok(route.indexOf('requireAttachmentBelongsToJob(') < route.indexOf("if (request.method === 'DELETE')"))
  assert.match(source, /attachments: \[\.\.\.rows.filter\(row => !row.hidden_at\)/)
  assert.match(source, /archivedAttachments: rows.filter\(row => row.hidden_at\)/)
  assert.match(source, /add column if not exists hidden_at timestamptz/)
})
