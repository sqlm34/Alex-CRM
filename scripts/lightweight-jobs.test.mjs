import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const htaccessSource = readFileSync(new URL('../public/.htaccess', import.meta.url), 'utf8')

function extractJobsListFields() {
  const match = workerSource.match(/const listFields = `([\s\S]*?)`/)
  assert.ok(match, 'Worker /api/jobs listFields block should exist')
  return match[1]
}

test('/api/jobs list payload stays lightweight', () => {
  const listFields = extractJobsListFields()

  assert.doesNotMatch(listFields, /jobs\.finance_items/)
  assert.doesNotMatch(listFields, /jobs\.payments/)
  assert.doesNotMatch(listFields, /model_photo_attachments/)
  assert.doesNotMatch(listFields, /jobs\.details/)
  assert.doesNotMatch(listFields, /jobs\.job_text/)
  assert.doesNotMatch(listFields, /jsonb_array/i)
  assert.doesNotMatch(listFields, /invoice_total/)
  assert.doesNotMatch(listFields, /paid_amount/)
  assert.doesNotMatch(listFields, /balance_due/)
  assert.doesNotMatch(listFields, /payment_status/)
})

test('job detail endpoint remains protected and full-detail capable', () => {
  assert.match(workerSource, /if \(jobMatch && request\.method === 'GET'\)/)
  assert.match(workerSource, /await requireJobAccess\(sql, user, decodeURIComponent\(jobMatch\[1\]\)\)/)
  assert.match(workerSource, /select \* from jobs where id\s*=\s*\$1 limit 1/s)
})

test('busy polling intervals are throttled', () => {
  assert.match(appSource, /const jobsPollIntervalMs = 30000/)
  assert.match(appSource, /const authHeartbeatIntervalMs = 30000/)
  assert.match(appSource, /const approvedUsersPollIntervalMs = 60000/)
  assert.match(appSource, /const bookingAvailabilityPollIntervalMs = 30000/)

  assert.doesNotMatch(appSource, /setInterval\([^;]+,\s*2500\)/s)
  assert.doesNotMatch(appSource, /setInterval\([^;]+,\s*5000\)/s)
  assert.doesNotMatch(appSource, /setInterval\([^;]+,\s*2000\)/s)
  assert.doesNotMatch(appSource, /setInterval\([^;]+,\s*1000\)/s)
})

test('frontend can fetch lightweight lists and full job details with abort signals', () => {
  assert.match(apiSource, /fetchJobsFromApi\(token\?: string, signal\?: AbortSignal\)/)
  assert.match(apiSource, /fetchJobFromApi\(id: string, token\?: string, signal\?: AbortSignal\)/)
  assert.match(appSource, /fetchJobFromApi\(id, authToken, controller\.signal\)/)
  assert.match(appSource, /rowToJob\(row: JobRow \| JobListRow, options:/)
  assert.match(appSource, /detailsLoaded/)
  assert.match(appSource, /Loading full job details/)
})

test('initial jobs list request is owned by useStoredJobs, not polling bootstrap', () => {
  assert.doesNotMatch(appSource, /syncNow\(false\)/)
  assert.match(appSource, /const timer = window\.setInterval\(\(\) => \{\s*syncNow\(\)\s*\}, jobsPollIntervalMs\)/s)
})

test('Hostinger rewrite rules do not turn missing assets or api calls into HTML', () => {
  assert.match(htaccessSource, /RewriteRule \^api\(\/\|\$\) - \[R=404,L\]/)
  assert.match(htaccessSource, /!\\\.\(\?:js\|mjs\|css\|map\|json/)
})
