import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => console.error(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  // All service traffic is stubbed: these tests must not place a call or create a job.
  await page.route('https://alex-crm-api.**/*', route => route.fulfill({ json: {} }))
  await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.turnstile={render:el=>{window.voiceHostAtVerification=!!el.closest(".booking-voice-host");return 0},reset:()=>{}}',
  }))
  await page.goto('http://127.0.0.1:5196/booking')
  await page.getByRole('region', { name: 'Choose a booking method' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Book an appliance repair' }).count(), 0)
  await page.getByRole('button', { name: /Book Online.*Continue Online/ }).click()
  await page.getByRole('button', { name: /Dryer/ }).waitFor()
  await mkdir('artifacts/booking-methods', { recursive: true })
  await page.locator('.booking-flow').screenshot({ path: 'artifacts/booking-methods/online.png' })
  await page.getByRole('button', { name: /Dryer/ }).click()
  await page.getByRole('heading', { name: 'When works best for you?' }).waitFor()
  await page.getByRole('button', { name: 'Booking options' }).click()
  await page.getByRole('button', { name: /Book Online.*Continue Online/ }).click()
  await page.getByRole('heading', { name: 'When works best for you?' }).waitFor()
  await page.getByRole('button', { name: 'Booking options' }).click()
  await page.getByRole('button', { name: /Book by Voice.*Start Voice Booking/ }).click()
  await page.locator('.voice-panel:not([hidden])').waitFor()
  assert.equal(await page.locator('.voice-booking').count(), 1)
  assert.equal(await page.locator('.booking-method-nav > span').count(), 0)
  assert.equal(await page.locator('.booking-method-nav').evaluate(el => getComputedStyle(el).marginTop), '40px')
  assert.equal(await page.locator('.booking-flow').isVisible(), false)
  assert.equal(await page.locator('.booking-voice-host > .voice-booking').count(), 1)
  assert.equal(await page.locator('.voice-launch').isVisible(), false)
  await page.waitForFunction(() => window.voiceHostAtVerification === true)
  assert.equal(await page.getByRole('button', { name: 'Open voice booking', exact: true }).count(), 0)
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    const box = await page.locator('.voice-panel').boundingBox()
    assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2, `voice center at ${width}`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `artifacts/booking-methods/voice-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  // Capture the actual existing order component, without starting Retell.
  await page.evaluate(() => document.querySelector('.voice-order').showModal())
  await page.locator('.voice-order').screenshot({ path: 'artifacts/booking-methods/order.png' })
  await page.getByRole('button', { name: 'Minimize booking order' }).click()
  // Exercise the same busy flag set by the unchanged widget while connecting/in a call.
  await page.evaluate(() => document.querySelector('.voice-booking').classList.add('voice-active'))
  await page.waitForFunction(() => document.querySelector('.booking-method-nav button').disabled)
  await page.evaluate(() => { document.querySelector('.voice-panel').hidden = true })
  await page.evaluate(() => document.querySelector('.voice-booking').classList.remove('voice-active'))
  await page.locator('.voice-panel:not([hidden])').waitFor()
  await page.getByRole('button', { name: 'Booking options' }).click()
  assert.equal(await page.locator('.voice-booking').isVisible(), false)
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.reload()
    await page.getByRole('region', { name: 'Choose a booking method' }).waitFor()
    await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0) })
    const grid = await page.locator('.booking-method-grid').boundingBox()
    assert.ok(Math.abs(grid.x + grid.width / 2 - width / 2) < 2)
    const header = await page.locator('.booking-header').boundingBox()
    if (width <= 600) assert.ok(Math.abs(grid.y - header.y - header.height - 16) < 2, `header gap at ${width}`)
    else {
      const content = await page.locator('.booking-content').boundingBox()
      assert.ok(Math.abs(grid.y + grid.height / 2 - content.y - content.height / 2) < 2, `vertical center at ${width}`)
    }
    assert.equal(await page.locator('.booking-method-card img').count(), 0)
    assert.equal(await page.locator('.booking-method-cta').count(), 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`)
    await page.screenshot({ path: `artifacts/booking-methods/chooser-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: /Book Online.*Continue Online/ }).click()
    assert.equal(await page.locator('.booking-method-nav').isVisible(), width > 600)
    await page.screenshot({ path: `artifacts/booking-methods/online-${width}.png`, fullPage: true })
  }
  console.log('PASS: entry screen, existing online form, retained selection, existing voice widget, active-call lock, responsive screenshots')
} finally { await browser.close() }
