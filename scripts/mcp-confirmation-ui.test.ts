import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { confirmationPage } from '../worker/mcp/confirmation'

test('confirmation page reviews exact details on desktop/mobile and submits only on click', async () => {
  const browser = await chromium.launch({ headless: true })
  const env = { MCP_RESOURCE_URL: 'https://mcp.example/mcp', MCP_OAUTH_ISSUER: 'https://issuer.example',
    MCP_CONFIRM_CLIENT_ID: 'synthetic', MCP_CONFIRM_AUTH_URL: 'https://issuer.example/authorize',
    MCP_CONFIRM_TOKEN_URL: 'https://issuer.example/token', TURNSTILE_SITE_KEY: 'test-only' }
  const details = { customer: 'TEST Customer', phone: '+13175550142', email: 'test@example.com',
    address: '1 Civic Square, Carmel, IN', zip: '46032', date: '2027-01-12', window: '9:00 AM - 11:00 AM',
    service: { appliance: 'Washer repair', issue: 'Does not drain' } }
  await mkdir('artifacts/mcp', { recursive: true })
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } })
      let submits = 0
      await page.addInitScript(() => sessionStorage.setItem('mcp-confirm', JSON.stringify({ verifier: 'test', state: 'state', intent: 'test', created: Date.now() })))
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.pathname === '/mcp/confirm') {
          const response = confirmationPage(env)
          return route.fulfill({ status: 200, headers: Object.fromEntries(response.headers), body: await response.text() })
        }
        if (url.pathname === '/token') return route.fulfill({ json: { access_token: 'synthetic' } })
        if (url.pathname === '/mcp/intent') return route.fulfill({ json: { action: 'createBooking', details } })
        if (url.pathname === '/mcp/approval') { submits++; assert.deepEqual(route.request().postDataJSON().details, details); return route.fulfill({ json: { confirmationToken: 'synthetic' } }) }
        if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render:(id,options)=>options.callback("test-only")}' })
        return route.abort()
      })
      await page.goto('https://mcp.example/mcp/confirm?code=test&state=state')
      await page.getByRole('button', { name: 'Confirm request' }).waitFor()
      assert.equal(submits, 0)
      assert.equal(await page.locator('dd').count(), 9)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: `artifacts/mcp/confirmation-${width}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Confirm request' }).click()
      await page.getByText('Your request is approved.', { exact: false }).waitFor()
      assert.equal(submits, 1)
      await page.close()
    }
  } finally { await browser.close() }
})
