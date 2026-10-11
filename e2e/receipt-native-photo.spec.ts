import { test, expect } from '@playwright/test'

test('receipt uses Android photo bytes, cancellation does not upload, successful selection scans once', async ({ page }) => {
  const user = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' }
  const job = { id: 'native-receipt', customer: 'Native Receipt Test', phone: '3175550123', address: 'Test', appliance: 'Dryer', issue: 'Test', service_date: '2026-10-11', service_window: '9:00 AM - 11:00 AM', status: 'scheduled', invoice: 0, paid: false, finance_items: [], payments: [] }
  await page.addInitScript(user => {
    localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test', user }))
    const host = window as unknown as Record<string, unknown>
    host.photoMode = 'cancel'
    host.Capacitor = {
      PluginHeaders: [{ name: 'PartsPhoto', methods: [{ name: 'pick', rtype: 'promise' }] }],
      nativePromise: async () => host.photoMode === 'cancel' ? { cancelled: true } : { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=' },
    }
  }, user)
  let uploads = 0, scans = 0, pickers = 0
  page.on('filechooser', () => pickers++)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.port === '5186') return route.continue()
    let body: unknown = []
    if (url.pathname === '/api/auth/me') body = user
    else if (url.pathname === '/api/jobs') body = [job]
    else if (url.pathname === '/api/jobs/native-receipt') body = job
    else if (url.pathname.endsWith('/receipts') && route.request().method() === 'GET') body = { receipts: [], aiEnabled: true }
    else if (url.pathname.endsWith('/uploads')) { uploads++; body = { attachment: { id: 'photo' }, upload: { url: 'https://test.invalid/upload', headers: {} } } }
    else if (url.pathname.endsWith('/complete')) body = { attachment: { id: 'photo' } }
    else if (url.pathname.endsWith('/receipts')) { scans++; body = { receipt: { id: 'r', status: 'draft', data: { supplier: 'Test', date: '2026-10-11', currency: 'USD', items: [], subtotalCents: 100, taxCents: 0, shippingCents: 0, totalCents: 100 } } } }
    await route.fulfill({ json: body })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Native Receipt Test/ }).click()
  await page.getByRole('button', { name: 'Finance', exact: true }).click()
  await page.getByRole('button', { name: 'Costs', exact: true }).click()
  await page.evaluate(() => { (window as unknown as { Capacitor: { getPlatform: () => string } }).Capacitor.getPlatform = () => 'android' })
  await page.getByRole('button', { name: 'Add receipt', exact: true }).click()
  await page.getByRole('button', { name: 'Choose file', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Add receipt', exact: true })).toBeEnabled()
  expect(uploads).toBe(0)
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).photoMode = 'success' })
  await page.getByRole('button', { name: 'Add receipt', exact: true }).click()
  await page.getByRole('button', { name: 'Choose file', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review receipt' })).toBeVisible()
  expect(uploads).toBe(1); expect(scans).toBe(1); expect(pickers).toBe(0)
})
