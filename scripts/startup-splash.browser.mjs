import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// PLAYWRIGHT_MODULE may point to an existing external Playwright installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const out = process.env.SPLASH_ARTIFACTS
if (!out) throw Error('Set SPLASH_ARTIFACTS to a directory outside Git')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const origin = 'http://127.0.0.1:4196'
const results = []
try {
  for (const [width, height] of [[320,568],[360,800],[393,873],[412,915],[393,852],[800,360],[1280,800]]) {
    const context = await browser.newContext({ viewport: { width, height }, recordVideo: width === 393 && height === 873 ? { dir: out, size: { width, height } } : undefined })
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/scripts/startup-splash.preview.html')
    await page.locator('.startup-splash').waitFor()
    const started = Date.now()
    await page.waitForTimeout(4600)
    const first = await page.evaluate(() => {
      const select = selector => getComputedStyle(document.querySelector(selector)).transform
      return { ring: select('.startup-ring'), wave: select('.startup-wave-0'), dot: select('.startup-dots span'), polls: Number(document.querySelector('output').textContent) }
    })
    assert.ok(first.polls >= 5, 'Underlying app continues initialization/polling')
    await page.screenshot({ path: out + '/splash-' + width + 'x' + height + '.png' })
    await page.waitForTimeout(350)
    const second = await page.evaluate(() => ({
      ring: getComputedStyle(document.querySelector('.startup-ring')).transform,
      wave: getComputedStyle(document.querySelector('.startup-wave-0')).transform,
      overflow: document.documentElement.scrollWidth > innerWidth,
      dots: document.querySelectorAll('.startup-dots span').length,
      inert: document.querySelector('.startup-app').inert,
      logo: document.querySelector('.startup-logo').naturalWidth,
      boxes: ['.startup-values','.startup-loading','.startup-waves','.startup-tagline'].map(s => {
        const r = document.querySelector(s).getBoundingClientRect()
        return { top:r.top,bottom:r.bottom,left:r.left,right:r.right }
      }),
    }))
    assert.notEqual(first.ring, second.ring)
    assert.notEqual(first.wave, second.wave)
    assert.equal(second.overflow, false)
    assert.equal(second.dots, 5)
    assert.equal(second.inert, true)
    assert.equal(second.logo, 512)
    assert.ok(second.boxes[1].bottom < second.boxes[2].top, 'Waves do not cover loading')
    assert.ok(second.boxes[2].bottom <= second.boxes[3].top, 'Waves do not cover tagline')
    await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 7000 })
    assert.ok(Date.now() - started >= 9400 && Date.now() - started < 11500, 'Ten-second timeline')
    assert.equal(await page.locator('.startup-app').evaluate(el => el.inert), false)
    assert.equal(await page.locator('input').inputValue(), 'Draft preserved')
    await page.getByRole('button', { name: 'Open job' }).click()
    assert.equal(await page.locator('.startup-splash').count(), 0)
    assert.deepEqual(errors, [])
    results.push({ width, height, animated: true, noOverlap: true, timeline: '10s', pollingPreserved: true })
    await context.close()
  }
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport:{width:393,height:873} })
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(origin + '/scripts/startup-splash.preview.html')
  await page.waitForTimeout(4500)
  assert.equal(await page.locator('.startup-logo').evaluate(el => getComputedStyle(el).animationName), 'none')
  assert.equal(await page.locator('.startup-wave').first().evaluate(el => getComputedStyle(el).animationName), 'none')
  await page.screenshot({ path: out + '/splash-reduced-motion.png' })
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 7000 })
  await page.goto(origin)
  assert.equal(await page.locator('.startup-splash').count(), 0, 'Normal web CRM has no forced splash')
  await page.goto(origin + '/booking')
  assert.equal(await page.locator('.startup-splash').count(), 0, 'Public booking has no splash')
  await context.close()
  console.log(JSON.stringify({ results, reducedMotion: 'passed', webAndBooking: 'no splash', runtime: 'simulated Android, not device' }, null, 2))
} finally { await browser.close() }
