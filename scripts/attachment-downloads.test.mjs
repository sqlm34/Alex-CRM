import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { signDownload, verifyDownload, downloadHeaders } from '../worker/attachmentDownloads.ts'

const secret = 'synthetic-test-only-signing-key'
const claims = { jobId: 'job', attachmentId: 'photo', sessionHash: 'session-hash', fingerprint: 'hash' }
test('download ticket is scoped, expires and rejects tampering or another key', async () => {
  const token = await signDownload(claims, secret, 1000)
  assert.deepEqual(await verifyDownload(token, secret, 1001), { ...claims, expires: 301000 })
  assert.equal(await verifyDownload(token, secret, 301000), null)
  assert.equal(await verifyDownload(token, 'wrong-key', 1001), null)
  assert.equal(await verifyDownload(token + 'x', secret, 1001), null)
  assert.equal(await verifyDownload('bad', secret), null)
})
test('download response forces saving and safely encodes filenames', () => {
  const headers = downloadHeaders('../photo\r\n".jpg')
  assert.equal(headers['Content-Type'], 'application/octet-stream')
  assert.equal(headers['Cache-Control'], 'private, no-store')
  assert.ok(headers['Content-Disposition'].startsWith('attachment;'))
  assert.doesNotMatch(headers['Content-Disposition'], /[\r\n]/)
  assert.ok(downloadHeaders('фото.jpg')['Content-Disposition'].includes('%D1%84'))
})

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const route = source.slice(source.indexOf('      const downloadLinkMatch'), source.indexOf('      const attachmentUrlMatch'))
const code = ts.transpile(route, { target: ts.ScriptTarget.ES2022 })
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function run(request, { loggedIn = true, allowed = true, legacy = false, changed = false, ready = true } = {}) {
  const sql = { query: async () => loggedIn ? [{ id: 'owner', role: 'owner' }] : [] }
  const deps = {
    request, url: new URL(request.url),
    env: { R2_SECRET_ACCESS_KEY: secret, ATTACHMENTS_BUCKET: { get: async () => ({ body: new Blob(['video-content']).stream() }) } },
    getSql: () => sql, ensureAuthTables: async () => {}, ensureJobAttachmentsTable: async () => {},
    signDownload, verifyDownload, downloadHeaders,
    authTokenHashFromRequest: async r => { if (!r.headers.get('Authorization')) throw new Error('Unauthorized'); return 'session-hash' },
    requireJobAccess: async () => { if (!allowed) throw new Error('Forbidden'); return { id: 'job', model_photo_attachments: [{ filename: 'old.jpg', content: btoa(changed ? 'changed' : 'legacy-content') }] } },
    legacyAttachmentRecords: a => a, sha256Hex: async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join(''),
    requireR2AttachmentsEnabled: () => {},
    requireAttachmentAccess: async () => ({ job_id: 'job', upload_status: ready ? 'ready' : 'pending', object_key: 'safe/key', original_filename: 'video.mp4' }),
    requireAttachmentBelongsToJob: (a, id) => { assert.equal(a.job_id, id) },
    json: body => Response.json(body), ApiHttpError: Error,
  }
  return new AsyncFunction(...Object.keys(deps), code)(...Object.values(deps))
}

for (const id of ['photo', 'legacy:0']) {
  test(`authorized ${id} downloads exact bytes; session/access/deletion checks remain enforced`, async () => {
    const request = new Request(`https://test.invalid/api/jobs/job/attachments/${id}/download-url`, { headers: { Authorization: 'Bearer synthetic' } })
    const { url } = await (await run(request)).json()
    assert.ok(!url.includes('Bearer'))
    const response = await run(new Request(url))
    assert.equal(await response.text(), id.startsWith('legacy') ? 'legacy-content' : 'video-content')
    assert.ok(response.headers.get('Content-Disposition').startsWith('attachment;'))
    await assert.rejects(run(new Request(url), { loggedIn: false }), /Session expired/)
    await assert.rejects(run(new Request(url), { allowed: false }), /Forbidden/)
    if (id.startsWith('legacy')) await assert.rejects(run(new Request(url), { changed: true }), /Attachment changed/)
    else await assert.rejects(run(new Request(url), { ready: false }), /not ready/)
  })
}
test('download link cannot be minted anonymously and invalid tickets return 403', async () => {
  await assert.rejects(run(new Request('https://test.invalid/api/jobs/job/attachments/photo/download-url')), /Unauthorized/)
  assert.equal((await run(new Request('https://test.invalid/api/attachment-download?ticket=bad'))).status, 403)
})
