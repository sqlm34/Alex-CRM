import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// All API traffic is intercepted. No production session or business data is used.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
const origin = process.env.SMOKE_URL || 'http://127.0.0.1:4194'
assert.equal(new URL(origin).hostname, '127.0.0.1')
const output = resolve(process.env.SMOKE_OUTPUT || `${tmpdir()}/alex-finance-item-flow-smoke`)
mkdirSync(output, { recursive: true })
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const pricing = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(read('../src/itemPricing.ts'), { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`)
const ast = ts.createSourceFile('worker.ts', read('../worker/index.ts'), ts.ScriptTarget.Latest, true)
const names = ['moneyToCents', 'centsToMoney', 'normalizeQuantity', 'calculateFinanceItemCents', 'clampFinanceCents', 'normalizeFinanceItems']
const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
assert.equal(selected.length, names.length)
const dependencies = { ...pricing, maxFinanceCents: 99999999, maxFinanceQuantity: 9999.999, maxTaxRateBps: 10000, cleanFinanceId: id => id }
const backend = new Function(...Object.keys(dependencies), `${ts.transpileModule(selected.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return {normalizeFinanceItems}`)(...Object.values(dependencies))
const user = { id: 'fixture-owner', name: 'Test Owner', email: 'owner@example.test', role: 'owner', provider: 'email' }
const catalog = [{ id: 'fixture-labor', name: 'Labor', description: '', category: 'Labor', unit_price_cents: 10000, taxable: false, active: true },
  { id: 'fixture-service-call', name: 'Service call', description: '', category: 'Service', unit_price_cents: 8900, taxable: false, active: true }]
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
try {
  for (const width of process.env.SMOKE_WIDTHS ? process.env.SMOKE_WIDTHS.split(',').map(Number) : [360, 393, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width === 360 ? 800 : 873 } })
    page.setDefaultTimeout(20000)
    let job = { id: 'J-FIXTURE-01', customer: 'Test Customer', phone: '', email: '', address: 'Test address', appliance: 'Test appliance', issue: 'Test service', service_date: new Date().toLocaleDateString('en-CA'), service_window: '9:00 AM - 11:00 AM', status: 'scheduled', invoice: 50, paid: false, finance_items: [{ id: 'legacy', label: 'Legacy service', amount: 50 }], payments: [], model_photo_attachments: [], lat: 0, lng: 0, created_at: new Date().toISOString() }
    let writes = 0, polls = 0, failNext = false
    const errors = [], forbidden = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await page.addInitScript(auth => { if (window.top === window && location.hostname === '127.0.0.1') localStorage.setItem('alex-crm-auth', JSON.stringify(auth)) }, { token: 'isolated-fixture-token', user })
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      if (path.startsWith('/api/')) {
        if (path === '/api/auth/me') return json(user)
        if (path === '/api/auth/heartbeat' || path === '/api/auth/offline') return json({ ok: true })
        if (path === '/api/price-book' && request.method() === 'GET') return json(catalog)
        if (path === '/api/jobs' && request.method() === 'GET') { polls++; const { finance_items, payments, model_photo_attachments, ...light } = job; return json([light]) }
        if (path === `/api/jobs/${job.id}`) {
          if (request.method() === 'PATCH') {
            writes++
            if (failNext) { failNext = false; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Fixture save failure"}' }) }
            const patch = request.postDataJSON()
            assert.deepEqual(Object.keys(patch).sort(), ['finance_items', 'invoice'])
            const next = backend.normalizeFinanceItems(patch.finance_items.map(item => pricing.prepareItemPricing(item, job.finance_items.find(old => old.id === item.id))))
            job = { ...job, finance_items: next, invoice: next.reduce((sum, item) => sum + item.lineTotalCents, 0) / 100 }
            await new Promise(resolve => setTimeout(resolve, 250))
          }
          return json(job)
        }
        if (path.endsWith('/attachments')) return json({ attachments: [] })
        if (path.includes('/stripe/terminal/config')) return json({ paymentAttemptsEnabled: false, enabled: false })
        if (request.method() !== 'GET') forbidden.push(`${request.method()} ${path}`)
        return json([])
      }
      if (url.origin === origin) return route.continue()
      return route.abort()
    })
    await page.goto(origin)
    await page.waitForTimeout(1000)
    await page.getByText('Test Customer', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Finance', exact: true }).click()
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByRole('dialog', { name: 'Price Book' }).waitFor()
    await page.getByRole('button', { name: 'Add new', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add price book item' }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByLabel('Search Price Book').fill('Labor')
    assert.equal(await page.locator('.fi-dialog').evaluate(node => node.parentElement.parentElement === document.body), true)
    assert.equal(await page.evaluate(() => document.getElementById('root').inert), true)
    await page.locator('.fi-catalog-select').filter({ hasText: 'Labor' }).click()
    assert.equal(writes, 0)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Base price', { exact: true }).fill('200.00')
    await page.getByLabel('Description', { exact: true }).fill('Draft survives polling')
    await page.waitForTimeout(width === 360 ? 41000 : 1000)
    if (!(await page.getByLabel('Description', { exact: true }).count())) {
      console.log('Unexpected UI after polling', { polls, errors, text: await page.locator('body').innerText() })
      await page.screenshot({ path: `${output}/poll-failure.png` })
    }
    assert.equal(await page.getByLabel('Description', { exact: true }).evaluate(node => node === document.activeElement), true)
    assert.equal(await page.getByLabel('Base price', { exact: true }).inputValue(), '200.00')
    assert.equal(writes, 0)
    await page.screenshot({ path: `${output}/editor-${width}.png` })
    if (width < 600) {
      await page.setViewportSize({ width, height: 400 })
      await page.getByLabel('Description', { exact: true }).focus()
      await page.getByLabel('Description', { exact: true }).scrollIntoViewIfNeeded()
      const footer = await page.locator('.fi-footer').boundingBox()
      assert.ok(footer.y >= 0 && footer.y + footer.height <= 400)
      await page.screenshot({ path: `${output}/short-viewport-${width}.png` })
      await page.setViewportSize({ width, height: width === 360 ? 800 : 873 })
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Add to job ($210.30)', exact: true }).waitFor()
    assert.equal(writes, 0)
    assert.equal(catalog[0].unit_price_cents, 10000)
    await page.getByRole('button', { name: 'Increase quantity' }).click()
    await page.getByRole('button', { name: 'Add to job ($420.60)', exact: true }).waitFor()
    await page.screenshot({ path: `${output}/selected-${width}.png` })
    failNext = true
    await page.getByRole('button', { name: 'Add to job ($420.60)', exact: true }).click()
    await page.locator('.fi-error').waitFor()
    assert.equal(job.finance_items.length, 1)
    const add = page.getByRole('button', { name: 'Add to job ($420.60)', exact: true })
    await add.evaluate(node => { node.click(); node.click() })
    await page.getByRole('dialog', { name: 'Selected item' }).waitFor({ state: 'hidden' })
    assert.equal(writes, 2)
    assert.equal(job.finance_items.length, 2)
    assert.equal(job.finance_items[0].amount, 50)
    assert.equal(job.finance_items[1].unitPriceCents, 21030)
    assert.equal(job.invoice, 470.6)
    assert.equal(await page.evaluate(() => document.getElementById('root').inert), false)
    await page.getByRole('button', { name: 'Actions for Labor' }).click()
    await page.locator('.fi-menu').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Save to job ($420.60)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items[1].unitPriceCents, 21030)
    await page.reload()
    await page.getByText('Test Customer', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Finance', exact: true }).click()
    await page.locator('.fi-row').filter({ hasText: 'Labor' }).waitFor()
    assert.match(await page.locator('.fi-totals').innerText(), /\$470.60/)
    assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth)), 0)
    await page.screenshot({ path: `${output}/finance-${width}.png` })
    const beforeCancel = writes
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByRole('button', { name: 'Custom item', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Unsaved draft')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog', { name: 'Price Book' }).waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(writes, beforeCancel)
    await page.getByRole('button', { name: 'Actions for Legacy service' }).click()
    await page.locator('.fi-menu').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Base price', { exact: true }).fill('50')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Save to job ($50.00)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items[0].baseUnitPriceCents, undefined)
    assert.equal(job.finance_items[0].amount, 50)
    await page.getByRole('button', { name: 'Actions for Labor' }).click()
    await page.locator('.fi-menu').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Discount', { exact: true }).fill('10.00')
    await page.getByLabel('Tax rate (%)', { exact: true }).fill('7.00')
    await page.getByLabel('Taxable', { exact: true }).check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Save to job ($439.34)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.invoice, 489.34)
    assert.equal(job.finance_items[1].unitPriceCents, 21030)
    assert.equal(job.finance_items[1].discountCents, 1000)
    assert.equal(job.finance_items[1].taxRateBps, 700)
    await page.getByRole('button', { name: 'View invoice', exact: true }).click()
    await page.locator('.invoice-sheet').waitFor()
    assert.match(await page.locator('.invoice-sheet').innerText(), /\$489.34/)
    assert.equal(await page.locator('.invoice-sheet').getByText('Base price', { exact: true }).count(), 0)
    assert.deepEqual(job.payments, [])
    job = { ...job, invoice: 0, finance_items: [] }
    const beforeEmpty = writes
    await page.reload()
    await page.getByText('Test Customer', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Finance', exact: true }).click()
    await page.getByText('No items', { exact: true }).waitFor()
    assert.equal(writes, beforeEmpty)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByRole('button', { name: 'Custom item', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Manual service')
    await page.getByLabel('Base price', { exact: true }).fill('100.00')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Add to job ($105.30)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items.length, 1)
    assert.equal(job.finance_items[0].unitPriceCents, 10530)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByRole('button', { name: 'Service call $89.00', exact: true }).click()
    await page.getByRole('button', { name: 'Add to job ($89.00)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items[1].unitPriceCents, 8900)
    await page.getByRole('button', { name: 'Actions for Service call', exact: true }).click()
    await page.locator('.fi-menu').getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Save to job ($89.00)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items[1].unitPriceCents, 8900)
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByRole('button', { name: 'Labor $105.30', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Service call')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Add to job ($100.00)', exact: true }).click()
    await page.locator('.fi-dialog').waitFor({ state: 'hidden' })
    assert.equal(job.finance_items[2].unitPriceCents, 10000)
    assert.equal(catalog[1].unit_price_cents, 8900)
    assert.deepEqual(forbidden, [])
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ width, writes, polls, total: job.invoice, errors, forbidden, legacyPreserved: true, catalogUnchanged: true }))
    await page.close()
  }
} finally { await browser.close() }
