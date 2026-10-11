import { test, expect } from '@playwright/test'

for (const width of [390, 1280]) test(`Jobs restores the selected card after back at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const user = { id: 'owner', email: 'owner@example.com', name: 'Owner', role: 'owner' }
  const jobs = Array.from({ length: 25 }, (_, i) => ({ id: `history-${i}`, customer: `Customer ${i}`, phone: '3175550123', address: 'Test address', appliance: 'Dryer', issue: 'Test', service_date: '2026-10-10', service_window: '1:00 PM - 3:00 PM', status: 'complete', invoice: 150, paid: true, created_at: `2026-10-10T12:${String(i).padStart(2, '0')}:00Z`, created_by_user_id: 'owner', finance_items: [], model_photo_attachments: [], payments: [] }))
  await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test', user })), user)
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    const job = jobs.find(j => url.pathname === `/api/jobs/${j.id}`)
    return route.fulfill({ json: url.pathname === '/api/auth/me' ? user : url.pathname === '/api/jobs' ? jobs : job || (url.pathname.endsWith('/attachments') ? { attachments: [] } : []) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  const cards = page.locator('[data-history-job-id]')
  await expect(cards).toHaveCount(25)
  for (const index of [12, 18]) {
    const card = cards.nth(index)
    await card.evaluate(el => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 120, behavior: 'instant' }))
    const before = await card.boundingBox()
    const scroll = await page.evaluate(() => window.scrollY)
    expect(scroll).toBeGreaterThan(1000)
    await card.getByRole('button').click()
    await expect(page.locator('.workiz-job-header')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('alexNativeBackSwipe')))
    await expect(cards).toHaveCount(25)
    await expect.poll(async () => Math.abs((await card.boundingBox())!.y - before!.y)).toBeLessThan(3)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
  }
})
