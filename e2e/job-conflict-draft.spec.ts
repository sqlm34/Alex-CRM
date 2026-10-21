import { test, expect } from '@playwright/test'

for (const width of [320, 390]) test(`conflicting job survives reload and can be explicitly booked at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const user = { id: 'owner', email: 'owner@example.com', name: 'Owner', role: 'owner' }
  let draft: Record<string, unknown> | null = null
  const saved: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  await page.addInitScript(user => localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test', user })), user)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    if (url.pathname === '/api/jobs' && route.request().method() === 'POST') {
      const job = route.request().postDataJSON()
      requests.push(job)
      if (!job.allow_overlap) {
        draft = job
        return route.fulfill({ status: 409, json: { error: 'Time booked; draft saved', code: 'BOOKING_CONFLICT_DRAFT_SAVED' } })
      }
      saved.push(job)
      draft = null
      return route.fulfill({ status: 201, json: job })
    }
    return route.fulfill({ json: url.pathname === '/api/auth/me' ? user : url.pathname === '/api/job-drafts' ? (draft ? [draft] : []) : url.pathname === '/api/jobs' ? saved : url.pathname.startsWith('/api/jobs/') ? saved[0] : [] })
  })
  const menu = async (name: string) => {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click()
    await page.getByRole('button', { name, exact: true }).click()
  }
  await page.goto('/')
  await menu('New job')
  const form = page.locator('.new-customer-page')
  await form.getByLabel('Customer', { exact: true }).fill('New Caller')
  await form.getByLabel('Phone', { exact: true }).fill('3175550199')
  await form.getByLabel('Address', { exact: true }).fill('42 Test Road')
  await form.getByLabel('Appliance', { exact: true }).fill('Washer')
  await form.getByLabel('Problem', { exact: true }).fill('Drain problem')
  await form.getByLabel('Date', { exact: true }).fill('2026-10-14')
  await form.getByRole('button', { name: 'Save job', exact: true }).click()
  await expect(page.locator('.job-conflict-notice')).toBeVisible()
  await expect(form.getByLabel('Customer', { exact: true })).toHaveValue('New Caller')
  await page.reload()
  await menu('Clients')
  await page.getByRole('searchbox').fill('New Caller')
  await expect(page.locator('.client-draft-card')).toHaveCount(1)
  await page.locator('.client-draft-card').click()
  await expect(form.getByRole('textbox', { name: 'Problem', exact: true })).toHaveValue('Drain problem')
  await expect(form.getByLabel('Date', { exact: true })).toHaveValue('2026-10-14')
  await form.getByRole('button', { name: 'Save job', exact: true }).click()
  await expect(page.locator('.job-conflict-notice')).toBeVisible()
  await page.screenshot({ path: `test-results/job-conflict-${width}.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Create at this time anyway' }).click()
  expect(requests).toHaveLength(2)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Create at this time anyway' }).click()
  await expect(page.locator('.job-page')).toBeVisible()
  expect(requests).toHaveLength(3)
  expect(new Set(requests.map(job => job.id)).size).toBe(1)
  expect(saved).toHaveLength(1)
  await menu('Clients')
  await expect(page.locator('.client-draft-card')).toHaveCount(0)
  await expect(page.locator('.client-profile-card')).toHaveCount(1)
})
