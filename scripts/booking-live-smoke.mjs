import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message))
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url().split('?')[0], request.failure()?.errorText))
  page.on('response', response => { if (response.url().includes('voice-booking') || response.url().includes('turnstile')) console.log(response.status(), response.url().split('?')[0]) })
  await page.goto('https://www.aleksappliancerepair.com/booking/')
  await page.getByRole('region', { name: 'Choose a booking method' }).waitFor()
  await mkdir('artifacts/booking-live', { recursive: true })
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: `artifacts/booking-live/chooser-${width}.png`, fullPage: true })
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Overflow')
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: /Book Online.*Continue Online/ }).click()
  await page.getByRole('button', { name: 'Dryer repair', exact: true }).click()
  await page.getByRole('heading', { name: 'When works best for you?' }).waitFor()
  await page.getByRole('button', { name: 'Booking options' }).click()
  await page.getByRole('button', { name: /Book Online.*Continue Online/ }).click()
  await page.getByRole('heading', { name: 'When works best for you?' }).waitFor()
  await page.getByRole('button', { name: 'Booking options' }).click()
  await page.getByRole('button', { name: /Book by Voice.*Start Voice Booking/ }).click()
  await page.locator('.voice-panel:not([hidden])').waitFor()
  await page.waitForTimeout(10000)
  console.log('VOICE STATUS:', await page.locator('.voice-status').innerText())
  console.log('TURNSTILE FRAMES:', page.frames().map(f => f.url().split('?')[0]))
  console.log('START ENABLED:', await page.locator('.voice-start').isEnabled())
  await page.screenshot({ path: 'artifacts/booking-live/voice.png', fullPage: true })
  if (await page.locator('.voice-launch').isVisible()) throw new Error('Duplicate floating launcher')
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    const box = await page.locator('.voice-panel').boundingBox()
    if (Math.abs(box.x + box.width / 2 - width / 2) > 2) throw new Error(`Voice not centered: ${width}`)
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Voice overflow: ${width}`)
    await page.screenshot({ path: `artifacts/booking-live/voice-${width}.png`, fullPage: true })
  }
  await page.locator('.voice-panel').getByRole('link', { name: 'Book online', exact: true }).click()
  await page.getByRole('heading', { name: 'When works best for you?' }).waitFor()
  console.log('PASS: live entry, online, retained step, voice panel, online fallback. No calls or orders submitted.')
} finally { await browser.close() }
