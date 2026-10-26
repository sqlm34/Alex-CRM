import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const settings = JSON.parse(readFileSync(new URL('../worker/receptionist/approved-test-settings.json', import.meta.url), 'utf8'))

for (const width of [390, 768, 1366, 1920]) {
  test(`CRM layout and navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const user = { id: 'owner', email: 'owner@example.com', name: 'Alex Repair', role: 'owner' }
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indiana/Indianapolis' }).format(new Date())
    const jobs = [
      { id: 'design-test-1', customer: 'Test Customer', phone: '3175550142', address: '1 Civic Square, Carmel, IN 46032', appliance: 'Whirlpool washer', issue: 'Washer is not draining.', service_date: date, service_window: '9:00 AM - 11:00 AM', status: 'scheduled', invoice: 89, paid: false, created_at: `${date}T12:00:00Z`, created_by_user_id: 'owner', finance_items: [], model_photo_attachments: [], payments: [] },
      { id: 'design-test-2', customer: 'Test Customer Two', phone: '3175550143', address: 'Test service address', appliance: 'Samsung dryer', issue: 'Dryer is not heating.', service_date: date, service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 0, paid: false, created_at: `${date}T13:00:00Z`, created_by_user_id: 'owner', finance_items: [], model_photo_attachments: [], payments: [] },
    ]
    await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'local-design-test', user })), user)
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== 'http://127.0.0.1:5198') return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/inventory/parts') return route.fulfill({ json: { parts: [] } })
      if (url.pathname === '/api/receptionist/settings') return route.fulfill({ json: settings })
      if (url.pathname === '/api/receptionist/diagnostics') return route.fulfill({ json: { schemaReady: true, environmentEnabled: false } })
      if (url.pathname === '/api/receptionist/stats') return route.fulfill({ json: { total_calls: 0, booked_calls: 0, pending_callbacks: 0, priced_calls: 0, recorded_cost_cents: 0 } })
      const job = jobs.find(job => url.pathname === `/api/jobs/${job.id}`)
      if (job && route.request().method() === 'PATCH') Object.assign(job, route.request().postDataJSON())
      const json = url.pathname === '/api/auth/me' ? user : url.pathname === '/api/jobs' ? jobs : job || (url.pathname.endsWith('/attachments') ? { attachments: [] } : [])
      return route.fulfill({ json })
    })
    await page.goto('/')
    await expect(page.locator('.schedule-card').first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/redesign-schedule-${width}.png`, fullPage: true })
    if (width < 1100) {
      await expect(page.getByRole('navigation', { name: 'Quick navigation' })).toBeVisible()
      await expect(page.locator('#crm-navigation')).toHaveAttribute('inert', '')
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await expect(page.locator('#crm-navigation')).toBeVisible()
      await expect(page.locator('.workspace')).toHaveAttribute('inert', '')
      await page.keyboard.press('Escape')
      await expect(page.locator('#crm-navigation')).toHaveAttribute('inert', '')
    } else {
      await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible()
      await expect(page.locator('#crm-navigation')).not.toHaveAttribute('inert', '')
    }
    await page.locator('.schedule-card-open').first().click()
    await expect(page.locator('.workiz-job-header')).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Order sections' })).toBeVisible()
    await expect(page.getByLabel('Job financial summary')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/redesign-job-${width}.png`, fullPage: true })
    await page.getByLabel('Description', { exact: true }).fill('Updated test description')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Job details saved', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Finance', exact: true }).click()
    await page.locator('.finance-section').getByRole('button', { name: 'Payments', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Add offline payment' })).toBeVisible()
    await page.screenshot({ path: `test-results/redesign-finance-${width}.png`, fullPage: true })
    const nav = page.getByRole('navigation', { name: width < 1100 ? 'Quick navigation' : 'Main', exact: true })
    await nav.getByRole('button', { name: 'Clients', exact: true }).click()
    await expect(page.locator('.client-profile-card').first()).toBeVisible()
    await page.screenshot({ path: `test-results/redesign-clients-${width}.png`, fullPage: true })
    if (width < 1100) await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Parts Inventory' }).click()
    await expect(page.getByText('No Parts Found', { exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/redesign-inventory-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Add Part', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/redesign-add-part-${width}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    if (width < 1100) await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'AI Receptionist' }).click()
    await expect(page.getByRole('button', { name: /^Receptionist sections:/ })).toBeVisible()
    await page.getByRole('button', { name: /^Receptionist sections:/ }).click()
    await expect(page.getByRole('navigation', { name: 'Receptionist views' }).getByRole('button')).toHaveCount(8)
    await page.getByRole('navigation', { name: 'Receptionist views' }).getByRole('button', { name: 'Dashboard', exact: true }).click()
    await page.screenshot({ path: `test-results/redesign-receptionist-${width}.png`, fullPage: true })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
