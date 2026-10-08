import { test, expect, type Page } from '@playwright/test'

async function setup(page: Page, supported = true) {
  await page.addInitScript(({ supported }) => {
    localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user: { id: 'owner', role: 'owner', name: 'Owner' } }))
    const host = window as unknown as Record<string, unknown>
    class SpeechMock {
      onstart?: () => void
      onend?: () => void
      start() { host.voice = this; host.starts = Number(host.starts || 0) + 1; queueMicrotask(() => this.onstart?.()) }
      abort() { host.aborts = Number(host.aborts || 0) + 1; this.onend?.() }
    }
    host.SpeechRecognition = supported ? SpeechMock : undefined
    host.webkitSpeechRecognition = undefined
  }, { supported })
  const job = { id: 'voice-job', customer: 'Voice Test', phone: '3175550123', address: 'Test', appliance: 'Washer', issue: 'Test', service_date: '2026-10-08', service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 450, paid: false, created_at: '2026-10-08T12:00:00Z', created_by_user_id: 'owner', finance_items: [], model_photo_attachments: [], payments: [] }
  const searches: unknown[] = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    let body: unknown = []
    if (url.pathname === '/api/auth/me') body = { id: 'owner', role: 'owner', name: 'Owner' }
    else if (url.pathname === '/api/jobs') body = [job]
    else if (url.pathname === '/api/jobs/voice-job') body = job
    else if (url.pathname.endsWith('/attachments')) body = { attachments: [], archivedAttachments: [] }
    else if (url.pathname.endsWith('/parts')) body = { scan: null, parts: [], aiEnabled: true, suppliers: [{ supplier: 'reliable', status: 'CONNECTED', results: [] }, { supplier: 'marcone', status: 'CONNECTED', results: [] }] }
    else if (url.pathname.endsWith('/parts/models')) body = { supplier: 'reliable', models: [{ brand: 'Whirlpool', model: 'WTW5057LW0', diagramUrl: 'https://reliableparts.net/us/' }] }
    else if (url.pathname.endsWith('/parts/search')) {
      searches.push(route.request().postDataJSON())
      body = { id: 'search', suppliers: [{ supplier: 'reliable', status: 'PART_NOT_FOUND', results: [] }, { supplier: 'marcone', status: 'PART_NOT_FOUND', results: [] }] }
    }
    return route.fulfill({ json: body })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Voice Test/ }).click()
  await page.getByRole('button', { name: 'Parts', exact: true }).click()
  return searches
}

async function speech(page: Page, event: 'result' | 'error' | 'end' | 'processing', text = '') {
  await page.evaluate(({ event, text }) => {
    const voice = (window as unknown as { voice: { onresult?: (value: unknown) => void; onerror?: (value: unknown) => void; onend?: () => void; onspeechend?: () => void } }).voice
    if (event === 'result') voice.onresult?.({ results: [[{ transcript: text }]] })
    if (event === 'error') voice.onerror?.({ error: text })
    if (event === 'end') voice.onend?.()
    if (event === 'processing') voice.onspeechend?.()
  }, { event, text })
}

for (const width of [390, 1280]) test(`voice modes, manual searches and layout ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  const searches = await setup(page)
  await page.getByRole('button', { name: 'Dictate model number' }).click()
  await expect(page.getByText('Listening...', { exact: true })).toBeVisible()
  await speech(page, 'processing')
  await expect(page.getByText('Recognizing...', { exact: true })).toBeVisible()
  await speech(page, 'result', 'WTW 5057 LW zero')
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('WTW5057LW0')
  await expect(page.getByLabel('Part needed', { exact: true })).toHaveValue('')
  expect(searches).toHaveLength(0)
  await page.getByRole('radio', { name: 'By part number', exact: true }).check()
  await page.getByRole('button', { name: 'Dictate part number' }).click()
  await speech(page, 'result', 'W one one three nine nine four three seven')
  await expect(page.getByLabel('Part number', { exact: true })).toHaveValue('W11399437')
  expect(searches).toHaveLength(0)
  await page.getByRole('button', { name: 'Search suppliers', exact: true }).click()
  await expect.poll(() => searches.length).toBe(1)
  expect(searches[0]).toMatchObject({ query: 'W11399437', mode: 'part_number', identity: { model: '' } })
  await page.getByLabel('Brand', { exact: true }).fill('Whirlpool')
  await page.getByRole('button', { name: 'Find model / diagrams', exact: true }).click()
  await page.getByRole('radio', { name: 'Whirlpool WTW5057LW0', exact: true }).check()
  await page.getByRole('radio', { name: 'By name', exact: true }).check()
  for (const [language, text] of [['ru-RU', 'сливная помпа'], ['en-US', 'drain pump']]) {
    await page.getByLabel('Voice language').selectOption(language)
    await page.getByRole('button', { name: 'Dictate part name' }).click()
    expect(await page.evaluate(() => (window as unknown as { voice: { lang: string } }).voice.lang)).toBe(language)
    await speech(page, 'result', text)
    await expect(page.getByLabel('Part name', { exact: true })).toHaveValue(text)
  }
  expect(searches).toHaveLength(1)
  await page.getByRole('button', { name: 'Search suppliers', exact: true }).click()
  await expect.poll(() => searches.length).toBe(2)
  expect(searches[1]).toMatchObject({ query: 'drain pump', mode: 'name', identity: { model: 'WTW5057LW0' } })
  await page.getByLabel('Part name', { exact: true }).fill('fan motor')
  await expect(page.getByLabel('Part name', { exact: true })).toHaveValue('fan motor')
  await page.getByRole('button', { name: 'Dictate part name' }).click()
  await page.screenshot({ path: `test-results/parts-voice-${width}.png` })
  expect(await page.locator('.parts-screen').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Cancel voice input' }).click()
})

test('voice denial, silence, cancel, timeout, mode switch, background and unmount', async ({ page }) => {
  await setup(page)
  await page.getByRole('radio', { name: 'By part number', exact: true }).check()
  const mic = page.getByRole('button', { name: 'Dictate part number' })
  await mic.click()
  await expect(mic).toBeDisabled()
  await speech(page, 'error', 'not-allowed')
  await expect(page.getByRole('alert')).toContainText('Microphone permission denied')
  await mic.click()
  await speech(page, 'end')
  await expect(page.getByRole('alert')).toContainText('No speech detected')
  await mic.click()
  await speech(page, 'error', 'network')
  await expect(page.getByRole('alert')).toContainText('Could not recognize speech')
  await mic.click()
  await page.getByRole('button', { name: 'Cancel voice input' }).click()
  await speech(page, 'result', 'STALE123')
  await expect(page.getByLabel('Part number', { exact: true })).toHaveValue('')
  await mic.click()
  await page.getByRole('radio', { name: 'By name', exact: true }).check()
  await speech(page, 'result', 'STALE456')
  await expect(page.getByLabel('Part name', { exact: true })).toHaveValue('')
  await page.getByRole('radio', { name: 'By part number', exact: true }).check()
  await page.clock.install()
  await mic.click()
  await page.clock.fastForward(36000)
  await expect(page.getByRole('alert')).toContainText('No speech detected')
  await mic.click()
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(page.getByRole('button', { name: 'Cancel voice input' })).toHaveCount(0)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await mic.click()
  await page.getByRole('button', { name: 'Close parts search' }).click()
  await speech(page, 'result', 'STALE789')
  await page.getByRole('button', { name: 'Parts', exact: true }).click()
  await page.getByRole('radio', { name: 'By part number', exact: true }).check()
  await expect(page.getByLabel('Part number', { exact: true })).toHaveValue('')
  await mic.click()
  await speech(page, 'result', 'W 12345')
  await expect(page.getByLabel('Part number', { exact: true })).toHaveValue('W12345')
})

test('unsupported browser disables voice without breaking typing', async ({ page }) => {
  await setup(page, false)
  await expect(page.getByRole('button', { name: 'Dictate model number' })).toBeDisabled()
  await expect(page.getByText('Voice input is unavailable in this browser.')).toBeVisible()
  await page.getByLabel('Part needed', { exact: true }).fill('drain pump')
  await expect(page.getByLabel('Part needed', { exact: true })).toHaveValue('drain pump')
})

test('native photo bytes bypass WebView picker, scan once and never create attachments', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as Record<string, unknown>
    host.photoMode = 'success'
    host.photoSources = []
    host.Capacitor = {
      PluginHeaders: [{ name: 'PartsPhoto', methods: [{ name: 'pick', rtype: 'promise' }] }],
      nativePromise: async (_plugin: string, _method: string, options: { source: string }) => {
        (host.photoSources as string[]).push(options.source)
        if (host.photoMode === 'cancel') return { cancelled: true }
        if (host.photoMode === 'error') throw new Error('PHOTO_READ_FAILED')
        return { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=' }
      },
    }
  })
  await setup(page)
  await page.evaluate(() => { (window as unknown as { Capacitor: { getPlatform: () => string } }).Capacitor.getPlatform = () => 'android' })
  let scans = 0
  const writes: string[] = []
  page.on('request', req => { if (req.method() !== 'GET' && /\/(attachments|uploads)(\/|$)/.test(new URL(req.url()).pathname)) writes.push(req.url()) })
  await page.route('**/parts/scan', route => {
    scans++
    expect(route.request().headers()['content-type']).toBe('image/png')
    return route.fulfill({ json: { identity: { brand: 'Whirlpool', model: 'WTW5057LW0', serial: 'S', applianceType: 'Washer', confidence: 1, alternatives: [] } } })
  })
  await page.getByLabel('Part needed', { exact: true }).fill('old query')
  await page.getByRole('button', { name: 'Gallery', exact: true }).click()
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('WTW5057LW0')
  await expect(page.getByLabel('Part needed', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'View label photo' })).toBeVisible()
  expect(scans).toBe(1)
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).photoMode = 'cancel' })
  await page.getByRole('button', { name: 'Gallery', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Gallery', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('WTW5057LW0')
  expect(scans).toBe(1)
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).photoMode = 'error' })
  await page.getByRole('button', { name: 'Gallery', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Android could not read this photo')
  expect(scans).toBe(1)
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).photoMode = 'success' })
  await page.getByRole('button', { name: 'Scan label', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Scan label', exact: true })).toBeEnabled()
  expect(scans).toBe(2)
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).photoSources)).toEqual(['gallery', 'gallery', 'gallery', 'camera'])
  expect(writes).toEqual([])
})
