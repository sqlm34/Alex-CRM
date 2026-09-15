import { test, expect } from '@playwright/test'

test('real CRM opens today and offline item payment keeps Void opposite amount', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.clock.setFixedTime(new Date('2026-09-14T19:30:00Z'))
  const owner = { id: 'owner-test', email: 'owner@example.com', name: 'Owner', role: 'owner' }
  const job = { id: '23', customer: 'Leslie Mansard', phone: '3175550123', email: '', address: 'Test address',
    appliance: 'Washer', issue: 'Parts and labor', service_date: '2026-09-15', service_window: '1:00 PM - 3:00 PM', status: 'scheduled',
    invoice: 389.10, paid: false, created_at: '2026-09-14T12:00:00Z', created_by_user_id: 'owner-test',
    finance_items: [{ id: 'parts', label: 'Parts', amount: 231.30, quantity: 1, unitPriceCents: 23130, lineTotalCents: 23130 }, { id: 'labor', label: 'Labor', amount: 157.80, quantity: 1, unitPriceCents: 15780, lineTotalCents: 15780 }],
    model_photo_attachments: [],
    payments: [] as Record<string, unknown>[],
  }
  let recorded: Record<string, unknown> | undefined
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => dialog.dismiss())
  await page.addInitScript(user => {
    localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user }))
  }, owner)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    let body: unknown = []
    if (url.pathname === '/api/auth/me') body = owner
    else if (url.pathname === '/api/jobs') body = [{ ...job, id: 'old', customer: 'Past customer', service_date: '2026-09-06' }, job]
    else if (url.pathname === '/api/jobs/23') body = job
    else if (url.pathname.endsWith('/attachments')) body = { attachments: [] }
    else if (url.pathname.endsWith('/payments/offline')) {
      recorded = route.request().postDataJSON()
      job.payments.push({ id: 'cash-test', amount: Number(recorded!.amountCents) / 100, status: 'succeeded', source: 'offline', method: 'Cash', createdAt: '2026-09-14T19:30:00Z' })
      body = job
    }
    return route.fulfill({ json: body })
  })
  await page.goto('/')
  await expect(page.locator('.schedule-day-group[data-today]')).toContainText('No jobs scheduled today')
  await expect(page.getByRole('button', { name: /Past customer/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Earlier jobs', exact: true })).toHaveCount(0)
  await expect(page.locator('.schedule-day-group[data-today]')).toBeInViewport()
  await page.getByRole('button', { name: /Leslie Mansard/ }).click()
  await page.getByRole('button', { name: 'Finance', exact: true }).click()
  await page.getByRole('button', { name: 'Payments', exact: true }).click()
  await page.getByRole('button', { name: 'Add offline payment', exact: true }).click()
  await page.getByRole('checkbox', { name: /Parts/ }).check()
  await expect(page.getByLabel('Payment amount', { exact: true })).toHaveValue('231.30')
  await page.getByRole('checkbox', { name: /Labor/ }).check()
  await expect(page.getByLabel('Payment amount', { exact: true })).toHaveValue('389.10')
  await page.getByRole('checkbox', { name: /Labor/ }).uncheck()
  await page.screenshot({ path: 'test-results/offline-items.png', fullPage: true })
  await page.getByRole('button', { name: 'Save payment', exact: true }).click()
  await expect.poll(() => recorded?.amountCents).toBe(23130)
  const entry = page.locator('.finance-payments-list .payment-entry').first()
  const amount = await entry.locator('strong').boundingBox()
  const button = await entry.getByRole('button', { name: 'Void', exact: true }).boundingBox()
  expect(button!.x).toBeGreaterThan(amount!.x + amount!.width)
  expect(Math.abs(button!.y + button!.height / 2 - amount!.y - amount!.height / 2)).toBeLessThan(2)
  await page.screenshot({ path: 'test-results/actual-finance-void.png', fullPage: true })
  expect(errors).toEqual([])
})
