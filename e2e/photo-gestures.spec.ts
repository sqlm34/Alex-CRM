import { test, expect } from '@playwright/test'

test('photo rotates and zooms together, ignores native back swipe, and closes with X', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const owner = { id: 'test-owner', name: 'Owner', role: 'owner', email: 'owner@example.com' }
  const content = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 400; canvas.height = 300
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0088bb'; context.fillRect(0, 0, 400, 300)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const job = { id: 'photo-test', customer: 'Photo Test', phone: '3175550123', address: 'Test address', appliance: 'Washer', issue: 'Test', service_date: '2026-10-03', service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 0, paid: false, created_at: '2026-10-03T12:00:00Z', created_by_user_id: owner.id, finance_items: [], payments: [], model_photo_attachments: [{ filename: 'test.png', contentType: 'image/png', content, size: 1000 }] }
  await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user })), owner)
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    return route.fulfill({ json: url.pathname === '/api/auth/me' ? owner : url.pathname === '/api/jobs' ? [job] : url.pathname === '/api/jobs/photo-test' ? job : [] })
  })
  await page.goto('/')
  await page.locator('.schedule-card-open').click()
  await page.getByRole('button', { name: /1 attachment/ }).click()
  await page.locator('.attachment-gallery-main').click()
  const viewer = page.locator('.attachment-photo-preview')
  await expect(viewer.locator('img')).toBeVisible()
  const close = viewer.getByRole('button', { name: 'Close attachment' })
  const download = viewer.getByRole('button', { name: 'Download photo' })
  expect((await close.boundingBox())!.y).toBe((await download.boundingBox())!.y)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('alexNativeBackSwipe')))
  await expect(viewer).toBeVisible()
  await viewer.locator('.attachment-stage').evaluate(element => {
    element.setPointerCapture = () => {}
    for (const [type, id, x, y] of [['pointerdown', 1, 100, 200], ['pointerdown', 2, 200, 200], ['pointermove', 2, 200, 300]] as const) {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y }))
    }
  })
  await expect(viewer.locator('img')).toHaveAttribute('style', /rotate\(45deg\) scale\(1\.414/)
  await page.screenshot({ path: 'test-results/photo-gestures.png' })
  await close.click()
  await expect(viewer).toHaveCount(0)
})
