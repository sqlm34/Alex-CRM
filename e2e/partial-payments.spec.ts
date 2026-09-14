import { test, expect } from '@playwright/test'
for (const width of [360, 1280]) {
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
