import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 1280, height: 900 }]) {
  test(`full schedule opens today without trailing spacer ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.clock.setFixedTime(new Date('2026-09-14T19:30:00Z'))
    const owner = { id: 'owner-test', email: 'owner@example.com', name: 'Owner', role: 'owner' }
    const jobs = Array.from({ length: 16 }, (_, index) => ({
      id: `test-${index}`, customer: `Schedule customer ${index}`, phone: '3175550123',
      address: 'Synthetic address', appliance: 'Washer', issue: 'Test',
      service_date: `2026-09-${String(index + 6).padStart(2, '0')}`,
      service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 0, paid: false,
      created_at: '2026-09-01T12:00:00Z', created_by_user_id: owner.id,
      finance_items: [], payments: [], model_photo_attachments: [],
      booking_source: index === 0 ? null : index === 1 ? 'google' : 'website',
    }))
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user })), owner)
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.port === '5186') return route.continue()
      let body: unknown = []
      if (url.pathname === '/api/auth/me') body = owner
      if (url.pathname === '/api/jobs') {
        await new Promise(resolve => setTimeout(resolve, 250))
        body = jobs
      }
      await route.fulfill({ json: body })
    })
    await page.goto('/')
    const today = page.locator('[data-today] .schedule-day-row')
    await expect(page.locator('.schedule-card')).toHaveCount(16)
    await expect(page.locator('.schedule-card .booking-source-badge')).toHaveCount(15)
    await expect(page.locator('.schedule-card.website-order')).toHaveCount(14)
    await expect(page.locator('.schedule-card.website-order').first()).toHaveCSS('background-color', 'rgb(234, 245, 255)')
    await expect(page.locator('.schedule-card').nth(0)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(page.locator('.schedule-card').nth(1)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect.poll(async () => Math.abs((await today.boundingBox())!.y - 12)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: 'Earlier jobs', exact: true })).toHaveCount(0)
    await page.screenshot({ path: `test-results/schedule-today-${viewport.width}.png` })
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.getByRole('button', { name: /Schedule customer 0 / })).toBeInViewport()
    const before = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const last = page.locator('.schedule-card').last()
    await expect(last).toBeInViewport()
    const bottom = await last.boundingBox()
    expect(viewport.height - bottom!.y - bottom!.height).toBeLessThanOrEqual(16)
    await page.screenshot({ path: `test-results/schedule-bottom-${viewport.width}.png` })
    const menu = page.locator('.schedule-floating-menu')
    await expect(menu).toHaveCSS('position', 'fixed')
    expect(Math.round((await menu.boundingBox())!.y)).toBe(12)
    expect(Math.round((await menu.boundingBox())!.x)).toBe(viewport.width - 60)
    if (viewport.width === 390) {
      await expect(menu).toHaveCSS('opacity', '0', { timeout: 6500 })
      await page.locator('.schedule-day-row').last().dispatchEvent('touchstart')
      await expect(menu).toHaveCSS('opacity', '1')
      await menu.click()
      await expect(page.locator('.sidebar')).toHaveClass(/open/)
      await page.waitForTimeout(5500)
      await expect(menu).toHaveCSS('opacity', '1')
      await page.locator('.menu-close').click()
      await expect(menu).toHaveCSS('opacity', '0', { timeout: 6500 })
      await page.evaluate(() => window.scrollBy(0, -200))
      await expect(menu).toHaveCSS('opacity', '1')
      await page.locator('.schedule-card-open').last().click()
      await expect(page.locator('.workiz-job-header')).toBeVisible()
      await expect(page.locator('.workiz-job-header .booking-source-badge')).toHaveCount(0)
    }
    await page.reload()
    await expect.poll(async () => Math.abs(((await today.boundingBox())?.y ?? -100) - 12)).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
}
