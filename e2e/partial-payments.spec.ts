import { test, expect } from '@playwright/test'

test('timeline has inset actions, bottom clearance and compact paid badge', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/scripts/tap-payment.preview.html')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.evaluate(() => {
    document.body.innerHTML = `<main class="app-shell"><section class="workspace"><div class="workiz-job-detail"><section class="finance-section"><div class="timeline-payment-confirmation"><span class="timeline-paid-badge">Paid</span><span class="timeline-paid-meta"><strong>$389.10</strong><small>Sep 14, 2026, 3:37 PM</small></span></div><button class="back-button wide">View invoice</button><button class="primary-action wide">Send invoice</button></section></div></section></main>`
  })
  const panel = await page.locator('.finance-section').boundingBox()
  const button = await page.getByRole('button', { name: 'Send invoice' }).boundingBox()
  const badge = await page.getByText('Paid', { exact: true }).boundingBox()
  expect(button!.x - panel!.x).toBeGreaterThanOrEqual(19)
  expect(panel!.x + panel!.width - button!.x - button!.width).toBeGreaterThanOrEqual(19)
  expect(panel!.y + panel!.height - button!.y - button!.height).toBeGreaterThanOrEqual(59)
  expect(badge!.width).toBeLessThan(100)
  await page.screenshot({ path: 'test-results/timeline-spacing.png', fullPage: true })
})
for (const width of [360, 1280]) {
  test(`Void aligns with amount at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/scripts/tap-payment.preview.html')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.evaluate(() => {
      document.body.innerHTML = `<main class="app-shell"><section class="workspace"><div class="finance-payments-list"><article class="payment-entry"><div class="payment-entry-heading"><strong>$231.30</strong><button class="mini-action danger">Void</button></div><div class="payment-entry-details"><span>Cash</span><small>Sep 14, 2026, 3:37 PM</small></div></article></div></section></main>`
    })
    const amount = await page.getByText('$231.30', { exact: true }).boundingBox()
    const button = await page.getByRole('button', { name: 'Void' }).boundingBox()
    expect(button!.x).toBeGreaterThan(amount!.x + amount!.width)
    expect(Math.abs(button!.y + button!.height / 2 - amount!.y - amount!.height / 2)).toBeLessThan(2)
    await page.screenshot({ path: `test-results/void-${width}.png`, fullPage: true })
  })
  test(`partial amount and item selection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/scripts/tap-payment.preview.html')
    await page.getByRole('checkbox', { name: 'Parts' }).check()
    await expect(page.getByLabel('Payment amount', { exact: true })).toHaveValue('231.30')
    await page.getByRole('button', { name: 'Tap to Pay $231.30' }).click()
    await expect(page.locator('body')).toHaveAttribute('data-result', '231.3')
    await page.goto('/scripts/tap-payment.preview.html?balance=15780')
    await page.getByRole('checkbox', { name: 'Parts' }).check()
    await expect(page.getByRole('button', { name: /^Tap to Pay/ })).toBeDisabled()
    await page.getByRole('button', { name: 'Edit payment amount' }).click()
    await page.getByLabel('Payment amount', { exact: true }).fill('50.25')
    const dialog = page.getByRole('dialog')
    const box = await dialog.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `test-results/tap-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Tap to Pay $50.25' }).click()
    await expect(page.locator('body')).toHaveAttribute('data-result', '50.25')
  })
}
