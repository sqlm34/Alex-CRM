import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const attachmentUtilsSource = readFileSync(new URL('../src/attachmentUtils.ts', import.meta.url), 'utf8')
const { code } = await transform(attachmentUtilsSource, {
  format: 'esm',
  loader: 'ts',
  target: 'es2023',
})
const utils = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'

test('attachment content type resolution uses explicit data URL filename signature then legacy fallback', () => {
  assert.equal(utils.resolveAttachmentContentType({ contentType: 'image/webp', content: pngDataUrl, filename: 'photo.jpg' }), 'image/webp')
  assert.equal(utils.resolveAttachmentContentType({ content: pngDataUrl, filename: 'photo.jpg' }), 'image/png')
  assert.equal(utils.resolveAttachmentContentType({ content: 'AAAA', filename: 'photo.gif' }), 'image/gif')
  assert.equal(utils.resolveAttachmentContentType({ content: jpegBase64 }), 'image/jpeg')
  assert.equal(utils.resolveAttachmentContentType({ content: 'AAAA' }), 'image/jpeg')
  assert.equal(utils.resolveAttachmentContentType({ content: 'AAAA' }, false), 'application/octet-stream')
})

test('attachment object URL creation decodes image base64 without relying on render state', () => {
  const created = []
  const url = utils.attachmentToObjectUrl(
    { filename: 'legacy-photo', content: jpegBase64 },
    (blob) => {
      created.push(blob)
      return 'blob:alex-test'
    },
  )

  assert.equal(url, 'blob:alex-test')
  assert.equal(created.length, 1)
  assert.equal(created[0].type, 'image/jpeg')
})

test('attachment preview state reports load success and real image failures', () => {
  assert.equal(utils.attachmentPreviewStateForImageEvent('load', true), 'ready')
  assert.equal(utils.attachmentPreviewStateForImageEvent('load', false), 'error')
  assert.equal(utils.attachmentPreviewStateForImageEvent('error', true), 'error')
})

test('attachment rotation is normalized into the slider range', () => {
  assert.equal(utils.normalizeAttachmentRotation(270), -90)
  assert.equal(utils.normalizeAttachmentRotation(-270), 90)
  assert.equal(utils.normalizeAttachmentRotation(450), 90)
  assert.equal(utils.normalizeAttachmentRotation(180), 180)
})

test('attachment pan bounds use stage image dimensions and zoom', () => {
  assert.deepEqual(
    utils.constrainAttachmentPan(
      { x: 999, y: -999 },
      3,
      { stageWidth: 320, stageHeight: 240, imageWidth: 640, imageHeight: 480 },
    ),
    { x: 320, y: -240 },
  )
  assert.deepEqual(
    utils.constrainAttachmentPan(
      { x: 20, y: 20 },
      1,
      { stageWidth: 320, stageHeight: 240, imageWidth: 640, imageHeight: 480 },
    ),
    { x: 0, y: 0 },
  )
})

test('attachment pan bounds account for rotated image dimensions', () => {
  assert.deepEqual(
    utils.rotatedContainedImageSize(
      { stageWidth: 320, stageHeight: 240, imageWidth: 640, imageHeight: 480 },
      90,
    ),
    { width: 240, height: 320 },
  )
  assert.deepEqual(
    utils.constrainAttachmentPan(
      { x: 999, y: 999 },
      3,
      { stageWidth: 320, stageHeight: 240, imageWidth: 640, imageHeight: 480 },
      90,
    ),
    { x: 200, y: 360 },
  )
  const rotated45 = utils.rotatedContainedImageSize(
    { stageWidth: 320, stageHeight: 240, imageWidth: 640, imageHeight: 480 },
    45,
  )
  assert.ok(rotated45.width > 320)
  assert.ok(rotated45.height > 320)
})

test('attachment pointer distance supports pinch calculations', () => {
  assert.equal(utils.pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
})
