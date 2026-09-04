import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const helperSource = readFileSync(new URL('../worker/r2Attachments.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../migrations/2026-09-04_add_job_attachments_r2.sql', import.meta.url), 'utf8')
const wranglerSource = readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8')

const { code } = await transform(helperSource, {
  format: 'esm',
  loader: 'ts',
  target: 'es2023',
})
const helpers = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('R2 upload normalization enforces CRM limits by kind', () => {
  const image = helpers.normalizeAttachmentUploadInput({
    filename: 'model sticker.jpg',
    mime_type: 'image/jpeg',
    size_bytes: 15 * 1024 * 1024,
  })
  assert.equal(image.kind, 'image')
  assert.equal(image.extension, 'jpg')

  const video = helpers.normalizeAttachmentUploadInput({
    filename: 'repair.mov',
    mimeType: 'video/quicktime',
    sizeBytes: 100 * 1024 * 1024,
  })
  assert.equal(video.kind, 'video')
  assert.equal(video.extension, 'mov')

  const document = helpers.normalizeAttachmentUploadInput({
    filename: 'invoice.pdf',
    mime_type: 'application/pdf',
    size_bytes: 25 * 1024 * 1024,
  })
  assert.equal(document.kind, 'document')
  assert.equal(document.extension, 'pdf')

  assert.throws(
    () => helpers.normalizeAttachmentUploadInput({ filename: 'x.svg', mime_type: 'image/svg+xml', size_bytes: 100 }),
    /Unsupported attachment file type/,
  )
  assert.throws(
    () => helpers.normalizeAttachmentUploadInput({ filename: 'large.jpg', mime_type: 'image/jpeg', size_bytes: 15 * 1024 * 1024 + 1 }),
    /image attachment is too large/,
  )
})

test('R2 object keys do not include raw filenames or PII-shaped punctuation', () => {
  const key = helpers.createPendingAttachmentObjectKey('J-test/../customer@example.com', '11111111-2222-4333-8444-555555555555', 'jpg')
  assert.equal(key, 'pending/jobs/J-test----customer-example-com/11111111-2222-4333-8444-555555555555/original.jpg')
  assert.doesNotMatch(key, /@/)
  assert.doesNotMatch(key, /\.\./)
  assert.equal(
    helpers.createPermanentAttachmentObjectKey('J-1', 'att-1', 'png'),
    'jobs/J-1/att-1/original.png',
  )
  assert.equal(
    helpers.createDeletedAttachmentObjectKey('J-1', 'att-1', 'png'),
    'deleted/jobs/J-1/att-1/original.png',
  )
})

test('R2 presigned URL uses short-lived SigV4 query params without exposing the secret', async () => {
  const url = await helpers.createR2PresignedUrl({
    accountId: 'account123',
    accessKeyId: 'ACCESS1234',
    secretAccessKey: 'SECRET_DO_NOT_OUTPUT',
    bucketName: 'alex-crm-attachments-production',
    key: 'jobs/J-1/attachment/original.jpg',
    method: 'PUT',
    expiresSeconds: helpers.attachmentUploadUrlTtlSeconds,
    headers: {
      'Content-Type': 'image/jpeg',
    },
    now: new Date('2026-09-04T12:00:00.000Z'),
  })

  assert.match(url, /^https:\/\/account123\.r2\.cloudflarestorage\.com\/alex-crm-attachments-production\/jobs\/J-1\/attachment\/original\.jpg\?/)
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/)
  assert.match(url, /X-Amz-Expires=600/)
  assert.match(url, /X-Amz-SignedHeaders=content-type%3Bhost/)
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/)
  assert.doesNotMatch(url, /SECRET_DO_NOT_OUTPUT/)
})

test('Attachment signature validation rejects dangerous and mismatched files', () => {
  assert.doesNotThrow(() => helpers.validateAttachmentSignature('image/jpeg', 'jpg', new Uint8Array([0xff, 0xd8, 0xff, 0x00])))
  assert.doesNotThrow(() => helpers.validateAttachmentSignature('application/pdf', 'pdf', new TextEncoder().encode('%PDF-1.7')))
  assert.throws(
    () => helpers.validateAttachmentSignature('image/svg+xml', 'svg', new TextEncoder().encode('<svg></svg>')),
    /not allowed/,
  )
  assert.throws(
    () => helpers.validateAttachmentSignature('text/html', 'html', new TextEncoder().encode('<html></html>')),
    /not allowed/,
  )
  assert.throws(
    () => helpers.validateAttachmentSignature('image/png', 'png', new Uint8Array([0xff, 0xd8, 0xff])),
    /signature/,
  )
})

test('Worker exposes R2 attachment endpoints without changing legacy job detail payloads', () => {
  for (const token of [
    'attachmentsMatch',
    'attachmentUploadsMatch',
    'attachmentCompleteMatch',
    'attachmentUrlMatch',
    'attachmentMatch',
    'requireR2AttachmentsEnabled',
    'ATTACHMENTS_R2_ENABLED',
    'createPendingAttachmentObjectKey',
    'createPermanentAttachmentObjectKey',
    'moveAttachmentObjectToDeletedPrefix',
    'retireJobAttachmentsForDeletedJob',
    'Legacy attachments are available from full job details',
    'Legacy attachments cannot be modified from the R2 attachment API',
    'normalizeStoredModelPhotoAttachments(patch[field])',
  ]) {
    assert.match(workerSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  const listFields = workerSource.match(/const listFields = `([\s\S]*?)`/)?.[1] || ''
  assert.doesNotMatch(listFields, /model_photo_attachments/)
  assert.match(workerSource, /requireJobAccess\(sql, user/)
  assert.match(workerSource, /requireAttachmentAccess\(sql, user/)
  assert.match(workerSource, /requireAttachmentBelongsToJob\(attachment, job\.id\)/)
  assert.match(workerSource, /fetch\(url, \{ headers: \{ Range: 'bytes=0-511' \} \}\)/)
})

test('Migration is additive and keeps legacy model_photo_attachments intact', () => {
  assert.match(migrationSource, /create table if not exists public\.job_attachments/)
  assert.match(migrationSource, /job_id text not null references public\.jobs\(id\) on delete cascade/)
  assert.match(migrationSource, /uploaded_by text references public\.users\(id\) on delete set null/)
  assert.match(migrationSource, /upload_status text not null default 'pending'/)
  assert.match(migrationSource, /job_attachments_job_active_idx/)
  assert.match(migrationSource, /unique \(job_id, uploaded_by, idempotency_key\)/)
  assert.doesNotMatch(migrationSource, /drop column/i)
  assert.doesNotMatch(migrationSource, /model_photo_attachments\s*=/i)
})

test('Wrangler isolates preview from production R2 bucket binding', () => {
  const config = JSON.parse(wranglerSource)
  assert.equal(config.vars.ATTACHMENTS_R2_ENABLED, 'false')
  assert.equal(config.r2_buckets, undefined)
  assert.deepEqual(config.env.production.r2_buckets, [
    {
      binding: 'ATTACHMENTS_BUCKET',
      bucket_name: 'alex-crm-attachments-production',
    },
  ])
  assert.equal(config.env.production.vars.ATTACHMENTS_R2_ENABLED, 'true')
  assert.equal(config.env.production.vars.R2_BUCKET_NAME, 'alex-crm-attachments-production')
})
