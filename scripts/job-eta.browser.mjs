import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const width of [360, 393]) {
    const page = await browser.newPage({ viewport: { width, height: 873 } })
    await page.route('https://**/*', (route) => route.abort())
    await page.goto('http://127.0.0.1:4197')
    await page.getByText('ORDER# 01', { exact: true }).click()
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
        getCurrentPosition(ok) {
          ok({ timestamp: Date.now(), coords: { latitude: 39.7, longitude: -86.1, accuracy: 20 } })
        },
      } })
      window.google = { maps: { importLibrary: async () => ({ Route: {
        computeRoutes: async () => ({ routes: [{ durationMillis: 1662000 }] }),
      } }) } }
    })
    await page.getByRole('button', { name: 'TEXT ETA', exact: true }).click()
    await page.getByText("Hello, Maria. I'm on the way, I'll be there in 28 minutes. Thanks.", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    console.log(`${width}px: prepared exact template; no horizontal overflow; external requests blocked`)
    await page.close()
  }
} finally {
  await browser.close()
}
