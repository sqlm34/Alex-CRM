import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('real HEIC decoder produces viewable JPEG for upload and existing attachments', async ({ page, request }) => {
  test.setTimeout(90000)
  // Public libheif sample; HEIC_TEST_FILE allows an offline fixture instead.
  const sample = process.env.HEIC_TEST_FILE
    ? await readFile(process.env.HEIC_TEST_FILE)
    : await (await request.get('https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic')).body()
  await page.route('**/heic-test-fixture', route => route.fulfill({ body: sample, contentType: 'application/octet-stream' }))
  await page.goto('/scripts/tap-payment.preview.html')
  const result = await page.evaluate(async () => {
    const { compatibleImageFile, compatibleImageBlob } = await import(/* @vite-ignore */ '/src/heicImages.ts')
    const source = await (await fetch('/heic-test-fixture')).blob()
    const file = await compatibleImageFile(new File([source], 'client.HEIC', { type: '' }))
    const stored = await compatibleImageBlob(source, 'old.heic')
    const renamed = await compatibleImageBlob(source, 'renamed.jpg')
    const image = new Image()
    image.src = URL.createObjectURL(stored)
    await image.decode()
    document.body.replaceChildren(image)
    const unchanged = await compatibleImageFile(file)
    let rejected = false
    try { await compatibleImageBlob(new Blob(['broken'], { type: 'image/heic' }), 'broken.heic') } catch { rejected = true }
    return { name: file.name, type: file.type, bytes: [...new Uint8Array(await file.slice(0, 3).arrayBuffer())],
      width: image.naturalWidth, height: image.naturalHeight, unchanged: unchanged === file, renamedType: renamed.type, rejected }
  })
  expect(result).toMatchObject({ name: 'client.jpg', type: 'image/jpeg', bytes: [255, 216, 255], unchanged: true, renamedType: 'image/jpeg', rejected: true })
  expect(result.width).toBeGreaterThan(100)
  expect(result.height).toBeGreaterThan(100)
  await page.screenshot({ path: 'test-results/heic-decoded.png' })
})
