import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const jobMergeSource = readFileSync(new URL('../src/jobMerge.ts', import.meta.url), 'utf8')

test('existing job card edits use a local draft and save cancel controls', () => {
  assert.match(appSource, /type JobEditableDraft = Pick<Job, 'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue'>/)
  assert.match(appSource, /const \[editDraft, setEditDraft\] = useState<JobEditableDraft>/)
  assert.match(appSource, /const editPatch = useMemo\(\(\) => jobEditablePatch\(activeJob, editDraft\)/)
  assert.match(appSource, /<button className="back-button" type="button" onClick=\{cancelEdit\} disabled=\{!editDirty \|\| editSaving\}>/)
  assert.match(appSource, /<button className="primary-action" type="submit" disabled=\{!detailsReady \|\| !editDirty \|\| editSaving\}>/)
})

test('job details save waits for full details and sends only changed fields', () => {
  assert.match(appSource, /if \(!previousJob \|\| !canUseJobDetails\(previousJob\)\) return Promise\.resolve\(false\)/)
  assert.match(appSource, /const fields = \['customer', 'phone', 'email', 'address', 'appliance', 'issue'\] as const/)
  assert.match(appSource, /if \(nextValue !== currentValue\) patch\[field\] = nextValue/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id, jobToRow/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id,[\s\S]{0,120}financeItems/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id,[\s\S]{0,120}modelPhotoAttachments/)
})

test('API and Worker whitelist appliance and issue without new DB columns', () => {
  assert.match(apiSource, /'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue'/)
  assert.match(workerSource, /'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue'/)
  assert.match(workerSource, /const fields = \['customer', 'phone', 'email', 'address', 'appliance', 'issue',/)
  assert.doesNotMatch(workerSource, /alter table jobs add column if not exists job_name/i)
  assert.doesNotMatch(workerSource, /alter table jobs add column if not exists job_text/i)
})

test('dirty draft is protected from polling and close can be confirmed', () => {
  assert.match(appSource, /dirtyJobIdsRef\.current\.add\(id\)[\s\S]*syncJobPatch\(id, patch, authToken\)/)
  assert.match(jobMergeSource, /dirtyIds\.has\(incomingJob\.id\)[\s\S]*return currentJob/)
  assert.match(appSource, /beforeunload/)
  assert.match(appSource, /Discard unsaved job changes/)
})

test('photo viewer uses selected attachment Blob URL instead of window open or direct data img', () => {
  assert.doesNotMatch(appSource, /window\.open\([^)]*attachment/i)
  assert.match(appSource, /function attachmentObjectUrl\(attachment: ModelPhotoAttachment\)/)
  assert.match(appSource, /URL\.createObjectURL\(new Blob/)
  assert.match(appSource, /URL\.revokeObjectURL\(imageUrl\)/)
  assert.doesNotMatch(appSource, /<img src=\{attachmentDataUrl\(attachment\)\}/)
})

test('photo viewer supports zoom pan rotation reset and safe unsupported fallback', () => {
  for (const token of ['setSafeZoom', 'constrainAttachmentPan', 'pointerDistance', 'RotateCcw', 'RotateCw', 'Reset', 'Photo preview unavailable', 'Download original']) {
    assert.ok(appSource.includes(token), `${token} should be present`)
  }
  assert.match(appSource, /clampNumber\(nextZoom, 1, 5\)/)
  assert.match(appSource, /onPointerDown=\{handlePointerDown\}/)
  assert.match(appSource, /onPointerMove=\{handlePointerMove\}/)
  assert.match(appSource, /type="range"[\s\S]*min="-180"[\s\S]*max="180"/)
  assert.match(cssSource, /\.attachment-preview-backdrop[\s\S]*overflow: hidden/)
  assert.match(cssSource, /\.attachment-controls button[\s\S]*min-height: 44px/)
})

test('attachment normalization accepts data URL raw base64 and object fields without decoding all attachments', () => {
  assert.match(appSource, /value\.content \|\| value\.data \|\| value\.base64/)
  assert.match(appSource, /stripDataUrlPrefix\(rawContent\)/)
  assert.match(appSource, /inferAttachmentMimeType\(rawContent\)/)
  assert.doesNotMatch(appSource, /normalizeModelPhotoAttachments[\s\S]{0,400}base64ToBytes/)
})
