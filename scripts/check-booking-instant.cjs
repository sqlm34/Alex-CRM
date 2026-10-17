const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(process.argv[2] || 'http://127.0.0.1:4189/booking');
      const service = page.locator('.booking-choice').first();
      await service.waitFor({ state: 'visible' });
      await service.click();
      await page.getByRole('heading', { name: 'When works best for you?' }).waitFor({ timeout: 1000 });
      await page.locator('.booking-week-day:not(:disabled)').last().click();
      await page.locator('.booking-time-grid[aria-busy="false"]').waitFor();
      await page.locator('.booking-time:not(:disabled)').first().click();
      const start = Date.now();
      await page.locator('.booking-primary').click();
      await page.getByRole('heading', { name: 'Please provide your contact info' }).waitFor({ timeout: 1000 });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1500, `Transition took ${elapsed}ms`);
      assert.equal(await page.locator('.booking-runner-track, .booking-running-tech, .booking-card[inert]').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `.qa/booking-instant-${width}.png`, fullPage: true });
      console.log(`PASS ${width}px: date to contact ${elapsed}ms; no runner, lock, or overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
