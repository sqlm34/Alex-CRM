import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { confirmationPage } from '../worker/mcp/confirmation'

test('confirmation login uses configured SMS connection and PKCE without accepting query overrides', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const connection of [undefined, 'sms']) {
      const page = await browser.newPage()
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).pathname === '/authorize') return route.fulfill({ body: 'Test login' })
        const response = confirmationPage({ MCP_RESOURCE_URL: 'https://mcp.example/mcp',
          MCP_OAUTH_ISSUER: 'https://issuer.example', MCP_CONFIRM_CLIENT_ID: 'synthetic',
          MCP_CONFIRM_AUTH_URL: 'https://issuer.example/authorize', MCP_CONFIRM_TOKEN_URL: 'https://issuer.example/token',
          MCP_CONFIRM_CONNECTION: connection, TURNSTILE_SITE_KEY: 'test-only' })
        return route.fulfill({ headers: Object.fromEntries(response.headers), body: await response.text() })
      })
      await page.goto('https://mcp.example/mcp/confirm?intent=test&connection=untrusted')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await page.waitForURL('https://issuer.example/authorize?**')
      const query = new URL(page.url()).searchParams
      assert.equal(query.get('connection'), null)
      assert.equal(query.get('prompt'), 'none')
      assert.equal(query.get('code_challenge_method'), 'S256')
      assert.equal(query.get('resource'), 'https://mcp.example/mcp')
      assert.equal(query.get('redirect_uri'), 'https://mcp.example/mcp/confirm')
      assert.ok(query.get('code_challenge'))
      assert.ok(query.get('state'))
      await page.goto(`https://mcp.example/mcp/confirm?error=login_required&state=${query.get('state')}`)
      await page.waitForURL('https://issuer.example/authorize?**')
      const fallback = new URL(page.url()).searchParams
      assert.equal(fallback.get('connection'), connection ?? null)
      assert.equal(fallback.get('state'), query.get('state'))
      assert.equal(fallback.get('code_challenge'), query.get('code_challenge'))
      await page.goto(`https://mcp.example/mcp/confirm?error=login_required&state=${query.get('state')}`)
      await page.getByRole('alert').filter({ hasText: 'Sign-in was not completed' }).waitFor()
      await page.close()
    }
  } finally { await browser.close() }
})

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
