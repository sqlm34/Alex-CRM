import { test, expect } from '@playwright/test'

for (const width of [390, 1280]) test(`Statistics month, sources, costs and failure at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await page.clock.setFixedTime(new Date('2026-10-08T15:00:00Z'))
  const owner = { id: 'owner', email: 'owner@example.com', name: 'Owner', role: 'owner' }
  const base = { customer: 'Statistics Test', phone: '3175550123', address: 'Test', appliance: 'Washer', issue: 'Test', service_window: '1:00 PM - 3:00 PM', status: 'complete', invoice: 325, paid: false, finance_items: [], payments: [], created_at: '2026-09-01T12:00:00Z' }
  const jobs = [
    { ...base, id: 'phone', service_date: '2026-10-08' },
    { ...base, id: 'web', booking_source: 'website', service_date: '2026-10-09' },
    { ...base, id: 'google', booking_source: 'google_maps', service_date: '2026-10-10' },
    { ...base, id: 'canceled', status: 'canceled', service_date: '2026-10-10' },
    { ...base, id: 'old', service_date: '2026-09-03' },
  ]
  let fail = false
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user })), owner)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    let body: unknown = []
    if (url.pathname === '/api/auth/me') body = owner
    else if (url.pathname === '/api/jobs') body = jobs
    else if (/\/receipts$/.test(url.pathname)) {
      if (fail) return route.fulfill({ status: 503, json: { error: 'Test costs unavailable' } })
      body = { receipts: url.pathname.includes('/phone/') ? [
        { id: 'confirmed', status: 'confirmed', data: { totalCents: 1548 } },
        { id: 'void', status: 'voided', data: { totalCents: 99999 } },
      ] : [] }
    } else if (url.pathname.startsWith('/api/jobs/')) body = jobs.find(j => url.pathname.endsWith(`/${j.id}`))
    return route.fulfill({ json: body })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu', exact: true }).click()
  await page.getByRole('button', { name: 'Statistics', exact: true }).click()
  const stats = page.locator('.statistics-page')
  await expect(stats.getByLabel('Month')).toHaveValue('2026-10')
  await expect(stats.locator('.statistics-net dd')).toHaveText('$959.52')
  await expect(stats.locator('.statistics-legend dd')).toHaveText(['1 orders', '1 orders', '1 orders'])
  await expect(stats.getByText('2 orders have no confirmed parts receipts.', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const chart = stats.locator('.statistics-chart')
  expect((await chart.boundingBox())!.height).toBe(320)
  expect(await chart.locator('text').first().evaluate(el => getComputedStyle(el).fontSize)).toBe('14px')
  const dimensions = await chart.evaluate(el => ({ width: el.getBoundingClientRect().width, viewWidth: el.viewBox.baseVal.width }))
  expect(Math.abs(dimensions.width - dimensions.viewWidth)).toBeLessThan(1)
  await stats.screenshot({ path: `test-results/statistics-${width}.png` })
  await stats.getByLabel('Month').selectOption('2026-09')
  await expect(stats.locator('.statistics-net dd')).toHaveText('$325.00')
  fail = true
  await stats.getByRole('button', { name: 'Refresh statistics' }).click()
  await expect(stats.getByRole('alert')).toContainText('Financial totals are unavailable')
  await expect(stats.locator('.statistics-net')).toHaveCount(0)
  expect(errors).toEqual([])
})
