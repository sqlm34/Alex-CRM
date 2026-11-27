import { expect, test } from '@playwright/test'

test('a selected photo appears before upload finishes without being marked saved early', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-03T15:00:00Z'))
  const owner = { id: 'test-owner', name: 'Owner', role: 'owner', email: 'owner@example.test' }
  const job = { id: 'upload-test', customer: 'Upload Test', phone: '3175550123', address: 'Test address', appliance: 'Washer', issue: 'Test', service_date: '2026-10-03', service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 0, paid: false, created_at: '2026-10-03T12:00:00Z', created_by_user_id: owner.id, finance_items: [], payments: [], model_photo_attachments: [] }
  const meta = { id: 'test-photo', job_id: job.id, source: 'r2', kind: 'image', mime_type: 'image/png', original_filename: 'test.png', display_name: 'test.png', size_bytes: 100, upload_status: 'ready', created_at: '2026-10-03T12:00:00Z' }
  let listReads = 0, thumbReads = 0, writes = 0, completions = 0
  let release!: () => void, complete!: () => void
  const uploaded = new Promise<void>(resolve => { release = resolve })
  const proceed = new Promise<void>(resolve => { complete = resolve })
  let failCompletion = false
  await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user })), owner)
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.port === '5186') return route.continue()
    if (url.pathname === '/fake-r2') {
      writes++
      await uploaded
      return route.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } })
    }
    if (url.pathname.endsWith('/attachments/uploads')) return route.fulfill({ json: { attachment: { ...meta, upload_status: 'pending' }, upload: { url: 'https://mock-r2.example.test/fake-r2', headers: { 'Content-Type': 'image/png' } } } })
    if (url.pathname.endsWith('/complete')) {
      completions++
      await proceed
      return failCompletion ? route.fulfill({ status: 502, json: { error: 'Synthetic failure' } }) : route.fulfill({ json: { attachment: meta } })
    }
    if (url.pathname.endsWith('/attachments')) {
      listReads++
      return route.fulfill({ json: { attachments: [], archivedAttachments: [] } })
    }
    if (url.pathname.endsWith('/url')) thumbReads++
    return route.fulfill({ json: url.pathname === '/api/auth/me' ? owner : url.pathname === '/api/jobs' ? [job] : url.pathname === '/api/jobs/upload-test' ? job : [] })
  })
  await page.goto('/')
  await page.locator('.schedule-card-open').filter({ hasText: 'Upload Test' }).click()
  await page.getByRole('button', { name: 'No attachments' }).click()
  await expect(page.getByRole('button', { name: 'Add attachment' })).toBeEnabled()
  const baselineListReads = listReads
  const bytes = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100; canvas.height = 100
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0088bb'
    context.fillRect(0, 0, 100, 100)
    return canvas.toDataURL().split(',')[1]
  }), 'base64')
  const input = page.locator('.attachments-screen input[type=file]').last()
  const screen = page.getByRole('region', { name: 'Attachments', exact: true })
  const pending = screen.getByLabel('Uploads in progress')
  await input.setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: bytes })
  await expect(pending.locator('img')).toBeVisible()
  await expect.poll(() => writes).toBe(1)
  await expect(screen.getByRole('button', { name: 'Attachment actions' })).toHaveCount(0)
  release()
  await expect.poll(() => completions).toBe(1)
  await expect(pending.getByText('Saving…')).toBeVisible()
  await expect(screen.getByRole('button', { name: 'Attachment actions' })).toHaveCount(0)
  complete()
  await expect(screen.getByRole('button', { name: 'Attachment actions' })).toHaveCount(1)
  await expect(screen.locator('.attachment-gallery-main img')).toBeVisible()
  await expect(pending).toHaveCount(0)
  failCompletion = true
  await input.setInputFiles({ name: 'failed.png', mimeType: 'image/png', buffer: bytes })
  await expect.poll(() => completions).toBe(2)
  await expect(page.getByText('Upload failed. Try again', { exact: true })).toBeVisible()
  await expect(pending).toHaveCount(0)
  await expect(screen.getByRole('button', { name: 'Attachment actions' })).toHaveCount(1)
  expect(listReads).toBe(baselineListReads)
  expect(thumbReads).toBe(0)
})
