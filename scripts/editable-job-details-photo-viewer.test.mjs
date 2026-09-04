import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const jobMergeSource = readFileSync(new URL('../src/jobMerge.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../migrations/2026-09-04_add_independent_job_text_fields.sql', import.meta.url), 'utf8')

test('existing job card edits use a local draft and save cancel controls', () => {
  assert.match(appSource, /type JobEditableDraft = Pick<Job, 'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue' \| 'details' \| 'jobText'>/)
  assert.match(appSource, /const \[editDraft, setEditDraft\] = useState<JobEditableDraft>/)
  assert.match(appSource, /const editPatch = useMemo\(\(\) => jobEditablePatch\(activeJob, editDraft\)/)
  assert.match(appSource, /<button className="back-button" type="button" onClick=\{cancelEdit\} disabled=\{!editDirty \|\| editSaving\}>/)
  assert.match(appSource, /<button className="primary-action" type="submit" disabled=\{!detailsReady \|\| !editDirty \|\| editSaving\}>/)
})

test('client summary row opens the editable client fields without resetting the draft', () => {
  assert.match(appSource, /const clientNameInputRef = useRef<HTMLInputElement \| null>\(null\)/)
  assert.match(appSource, /const focusClientEditor = \(\) => \{[\s\S]*clientNameInputRef\.current\?\.focus\(\)[\s\S]*\}/)
  assert.match(appSource, /<button className="workiz-field-row" type="button" onClick=\{focusClientEditor\}>[\s\S]*<UsersRound/)
  assert.doesNotMatch(appSource, /focusClientEditor[\s\S]{0,160}setEditDraft/)
})

test('job details save waits for full details and sends only changed fields', () => {
  assert.match(appSource, /if \(!previousJob \|\| !canUseJobDetails\(previousJob\)\) return Promise\.resolve\(false\)/)
  assert.match(appSource, /\['details', 'details'\]/)
  assert.match(appSource, /\['jobText', 'job_text'\]/)
  assert.match(appSource, /if \(nextValue !== currentValue\) patch\[patchField\] = nextValue/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id, jobToRow/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id,[\s\S]{0,120}financeItems/)
  assert.doesNotMatch(appSource, /onSaveJobDetails\(activeJob\.id,[\s\S]{0,120}modelPhotoAttachments/)
})

test('four editable job fields are stored independently', () => {
  assert.match(appSource, /value=\{editDraft\.appliance\}[\s\S]{0,160}appliance: event\.target\.value/)
  assert.match(appSource, /value=\{editDraft\.issue\}[\s\S]{0,160}issue: event\.target\.value/)
  assert.match(appSource, /value=\{editDraft\.details\}[\s\S]{0,160}details: event\.target\.value/)
  assert.match(appSource, /value=\{editDraft\.jobText\}[\s\S]{0,160}jobText: event\.target\.value/)
  assert.doesNotMatch(appSource, /<h4>Details<\/h4>[\s\S]{0,350}editDraft\.appliance/)
  assert.doesNotMatch(appSource, /<h4>Job text<\/h4>[\s\S]{0,350}editDraft\.issue/)
})

test('API and Worker whitelist independent job text fields without auto-migrating DB', () => {
  assert.match(apiSource, /'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue' \| 'details' \| 'job_text'/)
  assert.match(workerSource, /'customer' \| 'phone' \| 'email' \| 'address' \| 'appliance' \| 'issue' \| 'details' \| 'job_text'/)
  assert.match(workerSource, /const fields = \['customer', 'phone', 'email', 'address', 'appliance', 'issue', 'details', 'job_text',/)
  assert.match(workerSource, /details: normalizeNullableJobText\(payload\.details\) \|\| appliance/)
  assert.match(workerSource, /job_text: normalizeNullableJobText\(payload\.job_text\) \|\|/)
  assert.doesNotMatch(workerSource, /alter table jobs add column if not exists details/i)
  assert.doesNotMatch(workerSource, /alter table jobs add column if not exists job_text/i)
})

test('additive migration creates details and job_text with backfill and rollback plan', () => {
  assert.match(migrationSource, /add column if not exists details text/i)
  assert.match(migrationSource, /add column if not exists job_text text/i)
  assert.match(migrationSource, /details = coalesce\(details, appliance\)/i)
  assert.match(migrationSource, /job_text = coalesce\(job_text, issue\)/i)
  assert.match(migrationSource, /begin;/i)
  assert.match(migrationSource, /commit;/i)
  assert.match(migrationSource, /Rollback plan/i)
  assert.match(migrationSource, /Drop them only after confirming/i)
})

test('dirty draft is protected from polling and close can be confirmed', () => {
  assert.match(appSource, /dirtyJobIdsRef\.current\.add\(id\)[\s\S]*syncJobPatch\(id, patch, authToken\)/)
  assert.match(jobMergeSource, /dirtyIds\.has\(incomingJob\.id\)[\s\S]*return currentJob/)
  assert.match(appSource, /beforeunload/)
  assert.match(appSource, /Discard unsaved job changes/)
})

test('photo viewer uses selected attachment Blob URL instead of window open or direct data img', () => {
  assert.doesNotMatch(appSource, /window\.open\([^)]*attachment/i)
  assert.match(appSource, /import \{ createPortal \} from 'react-dom'/)
  assert.match(appSource, /return createPortal\(/)
  assert.match(appSource, /document\.body/)
  assert.match(appSource, /const \[imageUrl, setImageUrl\] = useState\(''\)/)
  assert.match(appSource, /import type \{ AttachmentPreviewState \} from '\.\/attachmentUtils'/)
  assert.match(appSource, /const \[previewState, setPreviewState\] = useState<AttachmentPreviewState>\('loading'\)/)
  assert.match(appSource, /const nextImageUrl = attachmentToObjectUrl\(attachment\)/)
  assert.match(appSource, /if \(nextImageUrl\) URL\.revokeObjectURL\(nextImageUrl\)/)
  assert.doesNotMatch(appSource, /useMemo\(\(\) => attachmentToObjectUrl/)
  assert.match(appSource, /downloadUrl = previewState === 'error' \? safeAttachmentDownloadUrl\(attachment\) : ''/)
  assert.doesNotMatch(appSource, /<img src=\{attachmentDataUrl\(attachment\)\}/)
})

test('photo viewer supports zoom pan rotation reset and safe unsupported fallback', () => {
  for (const token of ['setSafeZoom', 'constrainAttachmentPan', 'pointerDistance', 'RotateCcw', 'RotateCw', 'Reset', 'Photo preview unavailable', 'Download original']) {
    assert.ok(appSource.includes(token), `${token} should be present`)
  }
  assert.match(appSource, /clampNumber\(nextZoom, 1, 5\)/)
  assert.match(appSource, /onPointerDown=\{handlePointerDown\}/)
  assert.match(appSource, /onPointerMove=\{handlePointerMove\}/)
  assert.match(appSource, /setPointerCapture\(event\.pointerId\)/)
  assert.match(appSource, /releasePointerCapture\(event\.pointerId\)/)
  assert.match(appSource, /movedDuringGestureRef\.current/)
  assert.match(appSource, /type="range"[\s\S]*min="-180"[\s\S]*max="180"/)
  assert.match(appSource, /const setSafeRotation = \(nextRotation: number\) => \{[\s\S]*normalizeAttachmentRotation\(nextRotation\)/)
  assert.match(appSource, /setSafeRotation\(rotation - 90\)/)
  assert.match(appSource, /setSafeRotation\(rotation \+ 90\)/)
  assert.match(appSource, /stageRef\.current\?\.getBoundingClientRect\(\)/)
  assert.match(cssSource, /\.attachment-preview-backdrop[\s\S]*overflow: hidden/)
  assert.match(cssSource, /\.attachment-loading/)
  assert.match(cssSource, /\.attachment-controls button[\s\S]*min-height: 44px/)
})

test('photo viewer reports image load failure instead of a blank preview', () => {
  assert.match(appSource, /window\.setTimeout\(\(\) => setPreviewState\('error'\), 10000\)/)
  assert.match(appSource, /window\.clearTimeout\(timeoutId\)/)
  assert.match(appSource, /onLoad=\{\(\) => \{[\s\S]*attachmentPreviewStateForImageEvent\('load', Boolean\(imageUrl\)\)/)
  assert.match(appSource, /onError=\{\(\) => setPreviewState\(attachmentPreviewStateForImageEvent\('error', Boolean\(imageUrl\)\)\)\}/)
  assert.match(appSource, /previewState !== 'error' \?/)
  assert.match(appSource, /Photo preview unavailable/)
})

test('attachment normalization accepts data URL raw base64 and object fields without decoding all attachments', () => {
  assert.match(appSource, /value\.content \|\| value\.data \|\| value\.base64/)
  assert.match(appSource, /stripDataUrlPrefix\(rawContent\)/)
  assert.match(appSource, /resolveAttachmentContentType\(value\)/)
  assert.doesNotMatch(appSource, /normalizeModelPhotoAttachments[\s\S]{0,400}base64ToBytes/)
})
