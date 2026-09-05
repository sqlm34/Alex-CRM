import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const attachmentUtilsSource = readFileSync(new URL('../src/attachmentUtils.ts', import.meta.url), 'utf8')
const { code } = await transform(attachmentUtilsSource, {
  format: 'esm',
  loader: 'ts',
  target: 'es2023',
})
const utils = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const legacyPhoto = {
  filename: 'legacy.jpg',
  contentType: 'image/jpeg',
  content: '/9j/4AAQSkZJRgABAQAAAQABAAD/2w==',
  size: 1234,
}

const readyR2 = {
  id: 'att-ready',
  source: 'r2',
  display_name: 'R2 ready',
  original_filename: 'ready.png',
  mime_type: 'image/png',
  kind: 'image',
  size_bytes: 2048,
  upload_status: 'ready',
  created_at: '2026-09-04T12:00:00Z',
}

test('attachment count labels cover none singular and plural', () => {
  assert.equal(utils.attachmentCountLabel(0), 'No attachments')
  assert.equal(utils.attachmentCountLabel(1), '1 attachment')
  assert.equal(utils.attachmentCountLabel(5), '5 attachments')
})

test('combined attachment count includes legacy and ready R2 only', () => {
  const combined = utils.normalizeGalleryAttachments([legacyPhoto], [
    readyR2,
    { ...readyR2, id: 'att-pending', upload_status: 'pending' },
    { ...readyR2, id: 'att-deleted', upload_status: 'deleted' },
  ])

  assert.equal(combined.length, 2)
  assert.equal(utils.activeAttachmentCount([legacyPhoto], [readyR2]), 2)
  assert.deepEqual(combined.map((attachment) => attachment.source), ['r2', 'legacy'])
})

test('R2 list failure keeps legacy UI path and disables upload affordance', () => {
  assert.match(appSource, /setAttachmentsError\(errorMessage\(error\) \|\| 'Attachment storage is temporarily unavailable'\)/)
  assert.match(appSource, /setR2Attachments\(\[\]\)/)
  assert.match(appSource, /attachmentsError \? <small>Attachment storage is temporarily unavailable<\/small> : null/)
  assert.match(appSource, /disabled=\{Boolean\(attachmentsError\)\}/)
  assert.match(appSource, /onRetryList=\{\(\) => void loadAttachmentMetadata\(\)\}/)
})

test('metadata-only initial loading does not request signed URLs until gallery thumbnail or viewer needs one', () => {
  assert.match(apiSource, /export async function fetchJobAttachments/)
  assert.match(appSource, /fetchJobAttachments\(activeJob\.id, authToken/)
  assert.match(appSource, /IntersectionObserver/)
  assert.match(appSource, /shouldFetchSignedUrl\(attachment, Date\.now\(\)\)/)
  assert.match(appSource, /attachmentThumbnailQueue = createAttachmentRequestQueue\(2\)/)
  assert.match(appSource, /response\.status === 403 && attempt === 0/)
  assert.match(appSource, /credentials: 'omit'/)
  assert.doesNotMatch(appSource, /localStorage[\s\S]{0,120}signed/i)
  assert.doesNotMatch(appSource, /console\.log\([^)]*signed/i)
})

test('upload client performs session PUT finalize and metadata refresh without legacy JSONB writes', () => {
  for (const token of [
    'createAttachmentUploadSession',
    'uploadAttachmentFile',
    'completeAttachmentUpload',
    'idempotencyKey',
    'setUploadItems',
    'await loadAttachmentMetadata()',
  ]) {
    assert.ok(appSource.includes(token), `${token} should be present`)
  }
  assert.match(apiSource, /method: 'PUT'/)
  assert.match(apiSource, /xhr\.upload\.onprogress/)
  assert.match(apiSource, /xhr\.getResponseHeader\('ETag'\)/)
  assert.match(apiSource, /xhr\.withCredentials = false/)
  assert.match(apiSource, /key\.toLowerCase\(\) === 'authorization'/)
  assert.match(apiSource, /key\.toLowerCase\(\) === 'content-length'/)
  assert.doesNotMatch(appSource, /syncJobPatch\(id, \{ model_photo_attachments/)
  assert.doesNotMatch(appSource, /filesToModelPhotoAttachments\(files\)/)
})

test('upload state machine is idempotent retryable and guarded after unmount', () => {
  for (const token of [
    "'validating'",
    "'creating'",
    "'uploading'",
    "'finalizing'",
    "'complete'",
    'file,',
    'idempotencyKey,',
    'session.attachment.id',
    'mountedRef.current',
    'setUploadItemsIfMounted',
    'cancelActiveUploads(uploadControllersRef.current)',
    'uploadFilesInLimitedBatches(nextFiles, (file) => uploadFileToR2',
  ]) {
    assert.ok(appSource.includes(token), `${token} should be present`)
  }
  assert.ok(appSource.indexOf("updateUploadProgress(item, 'complete', 100)") > appSource.indexOf('await completeAttachmentUpload'))
})

test('Android file permission errors require choosing the file again instead of stale retry', () => {
  const notReadable = new DOMException('The requested file could not be read', 'NotReadableError')
  const security = new DOMException('Permission denied', 'SecurityError')

  assert.equal(utils.isAttachmentFileReadError(notReadable), true)
  assert.equal(utils.isAttachmentFileReadError(security), true)
  assert.equal(utils.isAttachmentFileReadError('permission problems occurred after a reference to a file was acquired'), true)
  assert.equal(utils.attachmentUploadFailureAction(notReadable, false), 'choose-again')
  assert.equal(utils.attachmentUploadFailureAction(notReadable, true), 'retry')
  assert.equal(
    utils.attachmentUploadFailureMessage(notReadable),
    'The selected file is no longer readable. Choose it again to upload.',
  )
})

test('failed local-only upload cards stay hidden from the attachments gallery', () => {
  assert.match(appSource, /failureAction: validation \? 'remove' : undefined/)
  assert.match(appSource, /file: failureAction === 'choose-again' \? undefined : item\.file/)
  assert.doesNotMatch(appSource, /const visibleUploadItems = uploadItems\.filter/)
  assert.doesNotMatch(appSource, /Choose file again/)
  assert.doesNotMatch(appSource, />Remove<\/button>/)
  assert.doesNotMatch(appSource, /<div className="attachment-upload-list"/)
})

test('normal gallery uploads do not render transient retry cards or clear Android input early', () => {
  assert.match(appSource, /await loadAttachmentMetadata\(\)[\s\S]{0,180}setUploadItemsIfMounted\(\(current\) => current\.filter\(\(item\) => item\.id !== uploadId\)\)/)
  assert.match(appSource, /uploadFilesInLimitedBatches\(nextFiles[\s\S]{0,180}\.finally\(\(\) => \{[\s\S]{0,80}input\.value = ''/)
  const uploadStart = appSource.indexOf('void uploadFilesInLimitedBatches(nextFiles')
  const clearInput = appSource.indexOf("if (input) input.value = ''", uploadStart)
  const uploadFinally = appSource.indexOf('.finally(() => {', uploadStart)
  assert.ok(uploadStart > -1)
  assert.ok(uploadFinally > uploadStart)
  assert.ok(clearInput > uploadFinally)
  assert.doesNotMatch(appSource, /<div className="attachment-upload-list"/)
})

test('attachment rename and delete dialogs stay above the attachments screen on mobile', () => {
  assert.match(appSource, /function AttachmentDialogPortal\(\{ children \}: \{ children: ReactNode \}\)/)
  assert.match(appSource, /return createPortal\([\s\S]{0,180}attachment-modal-backdrop[\s\S]{0,180}document\.body/)
  const attachmentDialogUses = appSource.match(/<AttachmentDialogPortal>/g) || []
  assert.equal(attachmentDialogUses.length, 2)
  assert.match(cssSource, /\.attachments-screen[\s\S]*z-index: 70/)
  assert.match(cssSource, /\.attachment-modal-backdrop[\s\S]*z-index: 100/)
  assert.match(cssSource, /\.attachment-modal-backdrop[\s\S]*env\(safe-area-inset-top\)/)
  assert.match(cssSource, /\.attachment-modal-backdrop[\s\S]*overflow-x: hidden/)
  assert.match(cssSource, /\.attachment-modal-backdrop[\s\S]*width: 100vw/)
  assert.match(cssSource, /\.attachment-dialog[\s\S]*box-sizing: border-box/)
  assert.match(cssSource, /\.attachment-dialog[\s\S]*min-width: 0/)
  assert.match(cssSource, /\.attachment-dialog[\s\S]*width: min\(420px, calc\(100vw - max\(24px, env\(safe-area-inset-left\)\) - max\(24px, env\(safe-area-inset-right\)\)\)\)/)
  assert.match(cssSource, /\.attachment-dialog \.panel-heading[\s\S]*flex-wrap: wrap[\s\S]*min-width: 0/)
  assert.match(cssSource, /\.attachment-dialog \.panel-heading span[\s\S]*text-overflow: ellipsis[\s\S]*white-space: nowrap/)
  assert.match(cssSource, /\.attachment-dialog button[\s\S]*overflow-wrap: anywhere/)
  const normalizedCssSource = cssSource.replace(/\r\n/g, '\n')
  const mobileBackdropRule = normalizedCssSource.indexOf('  .modal-backdrop {\n    align-items: start;')
  const mobileAttachmentBackdropRule = normalizedCssSource.indexOf('  .attachment-modal-backdrop {\n    align-items: center;')
  const mobilePaymentRule = normalizedCssSource.indexOf('  .payment-modal {\n    max-width: none;')
  const mobileDialogRule = normalizedCssSource.indexOf('  .attachment-dialog {\n    max-width: 100%;')
  assert.ok(mobileBackdropRule > -1)
  assert.ok(mobileAttachmentBackdropRule > mobileBackdropRule)
  assert.ok(mobileAttachmentBackdropRule < mobilePaymentRule)
  assert.match(normalizedCssSource.slice(mobileAttachmentBackdropRule, mobileAttachmentBackdropRule + 120), /justify-items: center/)
  assert.ok(mobilePaymentRule > -1)
  assert.ok(mobileDialogRule > mobilePaymentRule)
  assert.match(normalizedCssSource.slice(mobileDialogRule, mobileDialogRule + 220), /width: min\(420px, calc\(100vw - max\(24px, env\(safe-area-inset-left\)\) - max\(24px, env\(safe-area-inset-right\)\)\)\)/)
  assert.match(normalizedCssSource.slice(mobileDialogRule, mobileDialogRule + 320), /\.attachment-dialog \.modal-actions \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/)
})

test('upload validation follows backend limits and blocks unsafe HTML SVG and unsupported types', () => {
  assert.equal(utils.validateGalleryFile({ name: 'x.svg', size: 100, type: 'image/svg+xml' }, 0), 'Unsupported file type')
  assert.equal(utils.validateGalleryFile({ name: 'x.html', size: 100, type: 'text/html' }, 0), 'Unsupported file type')
  assert.equal(utils.validateGalleryFile({ name: 'empty.png', size: 0, type: 'image/png' }, 0), 'Unsupported file type')
  assert.equal(utils.validateGalleryFile({ name: 'huge.jpg', size: 15 * 1024 * 1024 + 1, type: 'image/jpeg' }, 0), 'File is too large')
  assert.equal(utils.validateGalleryFile({ name: 'video.mp4', size: 100 * 1024 * 1024, type: 'video/mp4' }, 0), '')
})

test('camera gallery and file input modes are present and clear selected inputs', () => {
  assert.match(appSource, /accept="image\/\*"\s+capture="environment"/)
  assert.match(appSource, /accept="video\/\*"\s+capture="environment"/)
  assert.match(appSource, /accept="image\/\*,video\/\*"\s+multiple/)
  assert.match(appSource, /accept=\{acceptedAttachmentTypes\}\s+multiple/)
  assert.match(appSource, /if \(input\) input\.value = ''/)
})

test('Back during upload cancels active controllers through the attachment screen path', () => {
  assert.match(appSource, /Cancel active attachment upload\?/)
  assert.match(appSource, /cancelActiveUploads\(uploadControllersRef\.current\)/)
  assert.match(appSource, /uploadControllersRef\.current\.set\(uploadId, controller\)/)
  assert.doesNotMatch(appSource, /Discard unsaved job changes\?[\s\S]{0,200}attachment upload/)
})

test('viewer keeps portal behavior and adds R2 video file navigation support', () => {
  assert.match(appSource, /function RemoteAttachmentPreview/)
  assert.match(appSource, /function fetchAttachmentBlobWithSignedUrl/)
  assert.match(appSource, /URL\.createObjectURL\(blob\)/)
  assert.match(appSource, /URL\.revokeObjectURL\(objectUrl\)/)
  assert.match(appSource, /<video src=\{mediaUrl\} controls playsInline \/>/)
  assert.match(appSource, /Previous/)
  assert.match(appSource, /Next/)
  assert.match(appSource, /zoom <= 1/)
})

test('rename and soft delete are R2-only actions with server confirmation', () => {
  assert.match(apiSource, /export async function renameJobAttachment/)
  assert.match(apiSource, /method: 'PATCH'/)
  assert.match(apiSource, /export async function deleteJobAttachment/)
  assert.match(apiSource, /method: 'DELETE'/)
  assert.match(appSource, /attachment\.source === 'r2'/)
  assert.match(appSource, /await renameJobAttachment/)
  assert.match(appSource, /await deleteJobAttachment/)
  assert.match(appSource, /setR2Attachments\(\(current\) => current\.filter/)
})

test('download filenames are sanitized and signed downloads do not send cookies', () => {
  assert.match(appSource, /function safeDownloadFilename/)
  assert.match(appSource, /character\.charCodeAt\(0\)/)
  assert.match(appSource, /'\\\\\/:\*\?"<>\|'\.includes\(character\)/)
  assert.match(appSource, /download=\{safeDownloadFilename/)
  assert.match(appSource, /link\.download = safeDownloadFilename/)
  assert.match(appSource, /fetch\(signed\.url, \{ signal, credentials: 'omit' \}\)/)
})

test('layout protects mobile touch targets and horizontal overflow', () => {
  assert.match(cssSource, /\.attachments-screen[\s\S]*overflow: hidden/)
  assert.match(cssSource, /\.attachments-screen-body[\s\S]*overflow-y: auto/)
  assert.match(cssSource, /\.attachments-screen-body[\s\S]*align-content: start/)
  assert.match(cssSource, /\.attachment-gallery-list,[\s\S]*\.attachment-upload-list[\s\S]*gap: 6px/)
  assert.match(cssSource, /\.attachment-gallery-row[\s\S]*min-width: 0/)
  assert.match(cssSource, /\.attachment-gallery-main[\s\S]*min-height: 58px/)
  assert.match(cssSource, /\.attachments-screen-header \.workiz-icon-button[\s\S]*min-height: 44px/)
  assert.match(cssSource, /\.bottom-sheet-backdrop/)
})
