import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const mode of ['button', 'timer', 'escape']) {
    const page = await browser.newPage()
    // No calls, orders, or calendar events are created by this UI lifecycle test.
    await page.route('https://alex-crm-api.**/*', route => route.fulfill({ json: {} }))
    await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.turnstile={render:()=>0,reset:()=>{}}',
    }))
    await page.route('https://alex-repair.com/', route => route.fulfill({ body: '<h1>Home destination verified</h1>', contentType: 'text/html' }))
    await page.goto(`${process.env.BOOKING_TEST_URL || 'http://127.0.0.1:5196/booking'}?verify=${Date.now()}`)
    await page.getByRole('button', { name: /Book by Voice.*Start Voice Booking/ }).click()
    await page.locator('.voice-panel:not([hidden])').waitFor()
    await page.evaluate(() => {
      const order = document.querySelector('.voice-order')
      order.showModal()
      order.close()
    })
    assert.ok(page.url().includes('/booking'))
    await page.evaluate(() => document.querySelector('.voice-confirmation').showModal())
    assert.ok(page.url().includes('/booking'))
    if (mode === 'button') await page.getByRole('button', { name: 'Close confirmation' }).click()
    else if (mode === 'escape') await page.keyboard.press('Escape')
    else await page.evaluate(() => setTimeout(() => document.querySelector('.voice-confirmation').close(), 50))
    await page.waitForURL('https://alex-repair.com/')
    await page.close()
  }
  console.log('PASS: confirmation close, timer and Escape redirect home; draft close does not redirect. No real call or booking.')
} finally { await browser.close() }
