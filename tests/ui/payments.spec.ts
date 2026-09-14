import { test, expect } from '@playwright/test'
import { financials } from '../../shared/finance'

for (const native of [true, false]) {
  test(`${native ? 'Android bridge' : 'Desktop'}: partial payments, email later, resend and mobile width`, async ({ page }) => {
    await page.setViewportSize(native ? { width: 390, height: 844 } : { width: 1366, height: 900 })
    let job: any = {
      id: '23', customer: 'Leslie Mansard', phone: '317-555-0123', email: '', address: 'Test address',
      appliance: 'Washer', issue: 'Parts and labor', service_date: '2026-09-14', service_window: '1:00 PM - 3:00 PM',
      status: 'scheduled', invoice: 389.10, paid: true, created_at: '2026-09-14T12:00:00Z', lat: 0, lng: 0,
      finance_items: [{ id: 'parts', label: 'Parts', amount: 231.30 }, { id: 'labor', label: 'Labor', amount: 157.80 }], payments: [],
    }
    let prepared: any
    let cardCalls = 0
    let sent = 0
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('dialog', (dialog) => dialog.dismiss())
    await page.exposeFunction('testCardPayment', async (options: any) => {
      cardCalls++
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(options.amount).toBe(prepared.amount)
      return { paymentIntentId: prepared.id, amount: prepared.amount, currency: 'usd', status: 'succeeded' }
    })
    await page.addInitScript(({ native }) => {
      localStorage.setItem('alex-crm-auth', JSON.stringify({ token: 'test-only', user: { id: 'owner-test', email: 'owner@example.com', name: 'Owner', role: 'owner' } }))
      if (!native) return
      const win = window as any
      win.androidBridge = {}
      win.Capacitor = {
        PluginHeaders: ['StripeTerminal', 'App', 'LocalNotifications', 'PushNotifications'].map((name) => ({
          name, methods: ['enableBluetooth', 'collectPayment', 'checkPermissions', 'requestPermissions', 'createChannel', 'register', 'schedule', 'addListener', 'removeListener'].map((name) => ({ name, rtype: 'promise' })),
        })),
        nativePromise: async (plugin: string, method: string, options: any) => {
          if (plugin === 'StripeTerminal' && method === 'collectPayment') return win.testCardPayment(options)
          if (method === 'addListener') return 'test-listener'
          return { enabled: true, display: 'granted', receive: 'granted' }
        },
      }
    }, { native })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.port === '5186') return route.continue()
      if (url.port !== '5199') return route.fulfill({ status: 200, contentType: 'text/plain', body: '' })
      const path = url.pathname
      const method = route.request().method()
      const input = method === 'POST' || method === 'PATCH' ? route.request().postDataJSON() : null
      let body: any = { ok: true }
      if (path === '/api/auth/me') body = { id: 'owner-test', email: 'owner@example.com', name: 'Owner', role: 'owner' }
      else if (path === '/api/jobs') body = [job]
      else if (path === '/api/stripe/terminal/config') body = { ready: true, currency: 'usd', locationId: 'test-location' }
      else if (path === '/api/stripe/terminal/payment-intent') {
        prepared = { ...input, id: `pi_test${job.payments.length + 1}` }
        body = { ...prepared, clientSecret: 'test-only' }
      } else if (path.endsWith('/payments')) {
        const value = input.paymentIntentId ? prepared : input
        job.payments.push({ id: value.id, amount: value.amount / 100, createdAt: new Date().toISOString(), status: 'succeeded',
          method: input.paymentIntentId ? 'Tap to Pay' : 'Manual', paymentIntentId: input.paymentIntentId,
          itemAmounts: value.itemIds?.length ? Object.fromEntries(value.itemIds.map((id: string) => [id, Math.round(job.finance_items.find((i: any) => i.id === id).amount * 100)])) : {}, memo: value.memo })
        job.paid = financials(job.finance_items, job.payments).remaining === 0
        body = job
      } else if (path.endsWith('/invoice/email')) {
        sent++; body = { ok: true, email: job.email }
      } else if (path === '/api/jobs/23') {
        if (method === 'PATCH') job = { ...job, ...input }
        body = job
      } else if (method === 'GET') body = []
      return route.fulfill({ json: body })
    })
    await page.goto('/')
    await page.getByRole('button', { name: /Leslie Mansard/ }).click()
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send invoice', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add payment', exact: true }).click()
    const modal = page.getByRole('form', { name: 'Collect payment' })
    await page.getByRole('button', { name: 'Edit upcoming payment amount' }).click()
    await page.getByRole('checkbox', { name: /Parts/ }).check()
    await expect(page.getByLabel('Payment amount', { exact: true })).toHaveValue('231.30')
    const bounds = await modal.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(native ? 390 : 1366)
    await page.screenshot({ path: `test-results/${native ? 'android' : 'desktop'}-payment-edit.png`, fullPage: true })
    await modal.getByRole('button', { name: /(?:Tap to Pay|Record payment) \$231.30/ }).dblclick({ delay: 20 })
    await expect(modal).toBeHidden()
    expect(job.payments).toHaveLength(1)
    if (native) expect(cardCalls).toBe(1)
    expect(sent).toBe(0)
    await expect(page.getByText('Partially Paid', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add payment', exact: true })).toBeEnabled()
    await page.reload()
    await page.getByRole('button', { name: /Leslie Mansard/ }).click()
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await expect(page.getByText('Partially Paid', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add payment', exact: true }).click()
    await expect(page.getByLabel('Payment amount', { exact: true })).toHaveValue('157.80')
    await page.getByRole('button', { name: 'Edit upcoming payment amount' }).click()
    if (native) await expect(page.getByRole('checkbox', { name: /Parts/ })).toBeDisabled()
    await modal.getByRole('button', { name: /(?:Tap to Pay|Record payment) \$157.80/ }).click()
    await expect(modal).toBeHidden()
    expect(job.payments).toHaveLength(2)
    await expect(page.getByRole('status', { name: 'Paid order' })).toContainText('$389.10')
    await expect(page.getByRole('button', { name: 'Add payment', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('textbox', { name: /email/i }).fill('customer@example.com')
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    await page.getByRole('button', { name: 'Send invoice', exact: true }).click()
    await expect.poll(() => sent).toBe(1)
    await page.getByRole('button', { name: 'Send invoice', exact: true }).click()
    await expect.poll(() => sent).toBe(2)
    expect(job.email).toBe('customer@example.com')
    await page.getByRole('button', { name: 'View invoice', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Invoice preview' })).toContainText('$389.10')
    await page.screenshot({ path: `test-results/${native ? 'android' : 'desktop'}-invoice.png`, fullPage: true })
    expect(errors).toEqual([])
  })
}
