import { createServer } from 'node:http'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { authenticate } from '../worker/mcp/security'
import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

// Local, one-shot PKCE diagnostic. Never writes or prints codes, tokens or phone numbers.
const issuer = 'https://dev-k21kvn04qqxt0swn.us.auth0.com/'
const resource = 'https://alex-crm-mcp-staging.alexeasyrepair.workers.dev/mcp'
const client = 'u1FDrE67SOo5WnUosYAyuDl1mzIXHFw0'
const redirect = 'http://127.0.0.1:8765/callback'
const state = randomBytes(32).toString('base64url')
const verifier = randomBytes(32).toString('base64url')
const equal = (left: string, right: string) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
let consumed = false
let mcp: Client | undefined
let booking: Record<string, unknown> | undefined
let cancel: Record<string, unknown> | undefined
let phase = 'login'
let testPage = ''
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
async function tool(name: string, args: Record<string, unknown>) {
  const result = await mcp!.callTool({ name, arguments: args })
  const data = result.structuredContent as Record<string, unknown> | undefined
  if (result.isError) throw Error(`MCP tool failed: ${String(data?.error || 'unavailable')}`)
  return result.structuredContent as Record<string, any>
}
function approvalHtml(link: string) {
  const url = new URL(link)
  assert.equal(url.origin, new URL(resource).origin)
  assert.equal(url.pathname, '/mcp/confirm')
  return `<h1>Staging booking test</h1><p>This uses an isolated test database. No real visit.</p><p>Step: ${phase}</p><a href="${escape(url.href)}" target="_blank" rel="noreferrer">Review and approve test request</a><form method="post" action="/advance"><input type="hidden" name="state" value="${state}"><button>Continue after approval</button></form>`
}
async function beginBooking(token: string, phone: string) {
  phase = 'connect'
  mcp = new Client({ name: 'alex-mcp-real-booking-test', version: '1.0.0' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  phase = 'availability'
  const service = { appliance: 'Washer repair', issue: 'TEST ONLY - does not drain', diagnosis: 'unknown', requestedService: 'repair' }
  for (let days = 2; days <= 8; days++) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000))
    const slots = await tool('getAvailableSlots', { zip: '46032', address: '1 Civic Square, Carmel, IN', service, date })
    if (!Array.isArray(slots.windows) || !slots.windows.length) continue
    booking = { customer: 'TEST MCP Customer', phone, email: 'test@example.com', address: '1 Civic Square, Carmel, IN',
      zip: '46032', service, date, window: slots.windows[0], confirmed: true, idempotencyKey: crypto.randomUUID() }
    phase = 'booking-intent'
    const result = await tool('createBooking', booking)
    assert.equal(result.confirmationRequired, true)
    phase = 'createBooking'
    console.log('PASS: actual availability and secure booking confirmation required')
    return approvalHtml(result.confirmationUrl)
  }
  throw Error('No test availability')
}
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
  if (req.headers.host !== '127.0.0.1:8765') { res.writeHead(403); res.end(); return }
  const url = new URL(req.url || '/', redirect)
  const hasCookie = req.headers.cookie?.split(';').some(cookie => cookie.trim() === `mcp_oauth_state=${state}`)
  if (req.method === 'GET' && url.pathname === '/test' && testPage && hasCookie) {
    res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(testPage); return
  }
  if (req.method === 'POST' && url.pathname === '/advance' && mcp && booking) {
    if (!hasCookie || (req.headers.origin && !['null', 'http://127.0.0.1:8765'].includes(req.headers.origin))) { res.writeHead(403); res.end(); return }
    let body = ''
    for await (const chunk of req) { body += chunk; if (body.length > 1024) { res.writeHead(413); res.end(); return } }
    if (!equal(new URLSearchParams(body).get('state') || '', state)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', 'text/html;charset=utf-8')
    try {
      if (phase === 'createBooking') {
        const booked = await tool('createBooking', booking)
        assert.equal(booked.confirmed, true)
        assert.deepEqual(await tool('createBooking', booking), booked)
        const status = await tool('getBookingStatus', { bookingId: booked.bookingId })
        assert.equal(status.bookingId, booked.bookingId)
        const slots = await tool('getAvailableSlots', { zip: booking.zip, address: booking.address, service: booking.service, date: booking.date })
        assert.ok(!slots.windows.includes(booking.window))
        console.log(`PASS: created ${booked.bookingId}, idempotent retry, owned status, occupied slot excluded`)
        cancel = { bookingId: booked.bookingId, confirmed: true, idempotencyKey: crypto.randomUUID() }
        const pending = await tool('cancelBooking', cancel)
        assert.equal(pending.confirmationRequired, true)
        phase = 'cancelBooking'
        testPage = approvalHtml(pending.confirmationUrl)
        res.end(testPage); return
      }
      assert.equal(phase, 'cancelBooking')
      const canceled = await tool('cancelBooking', cancel!)
      assert.equal(canceled.canceled, true)
      assert.deepEqual(await tool('cancelBooking', cancel!), canceled)
      const available = await tool('getAvailableSlots', { zip: booking.zip, address: booking.address, service: booking.service, date: booking.date })
      assert.ok(available.windows.includes(booking.window))
      console.log('PASS: confirmed cancellation and idempotent cancellation retry')
      res.end('<h1>PASS</h1><p>Test booking created, verified and canceled. Production unchanged.</p>')
      await mcp.close(); mcp = undefined; server.close(); clearTimeout(timeout); return
    } catch (error) {
      console.log(error instanceof Error ? error.message : 'Test failed')
      res.end('<h1>Test incomplete</h1><p>No automatic retry. Review the test output.</p>'); return
    }
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  if (url.pathname === '/' && !consumed) {
    const auth = new URL('authorize', issuer)
    auth.search = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code',
      scope: 'openid phone booking:create booking:read booking:cancel', resource, state,
      prompt: process.argv.includes('--consent') ? 'consent' : 'none', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' }).toString()
    res.setHeader('Set-Cookie', `mcp_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`)
    res.writeHead(302, { Location: auth.href }); res.end(); return
  }
  if (url.pathname !== '/callback' || consumed || !equal(url.searchParams.get('state') || '', state)
    || !hasCookie) {
    res.writeHead(400); res.end('Invalid or expired test callback.'); return
  }
  consumed = true
  let message = 'OAuth test could not be completed. No booking was created.'
  try {
    const error = url.searchParams.get('error')
    if (error) {
      console.log(`OAuth interaction required: ${['login_required', 'consent_required', 'interaction_required'].includes(error) ? error : 'authorization_failed'}`)
      message = 'Sign-in or consent is required. No SMS was requested by this test. No booking was created.'
    } else {
      if (url.searchParams.get('iss') !== issuer || !url.searchParams.get('code')) throw Error('Invalid authorization response')
      const response = await fetch(new URL('oauth/token', issuer), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: client, redirect_uri: redirect, code: url.searchParams.get('code')!, code_verifier: verifier, resource }) })
      if (!response.ok) throw Error('Token exchange failed')
      const body = await response.json() as { access_token?: string }
      if (!body.access_token) throw Error('Token missing')
      const principal = await authenticate(new Request(resource, { headers: { Authorization: `Bearer ${body.access_token}` } }), {
        MCP_RESOURCE_URL: resource, MCP_OAUTH_ISSUER: issuer, MCP_OAUTH_JWKS_URL: new URL('.well-known/jwks.json', issuer).href,
        MCP_OAUTH_PHONE_CLAIM_NAMESPACE: `${new URL(resource).origin}/identity`,
      })
      if (!principal?.phone || !['booking:create', 'booking:read', 'booking:cancel'].every(scope => principal.scopes.includes(scope))) throw Error('Claims missing')
      if (process.argv.includes('--booking')) {
        testPage = await beginBooking(body.access_token, principal.phone)
        body.access_token = undefined
        res.writeHead(303, { Location: '/test' }); res.end(); return
      }
      body.access_token = undefined
      console.log('PASS: real PKCE exchange, JWT signature, audience, issuer, verified phone and three booking scopes')
      message = 'Verified phone and booking permissions confirmed. No booking was created.'
    }
  } catch (error) {
    console.log(`FAIL: stage ${phase}; ${error instanceof Error && /^MCP tool failed: [a-z_]+$/.test(error.message) ? error.message : 'verification incomplete'}`)
    await mcp?.close(); mcp = undefined
  }
  res.setHeader('Set-Cookie', 'mcp_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  res.setHeader('Content-Type', 'text/html;charset=utf-8')
  res.end(`<html><meta name="viewport" content="width=device-width"><title>MCP authentication test</title><body><h1>MCP authentication test</h1><p>${message}</p></body></html>`)
  server.close()
  clearTimeout(timeout)
})
const timeout = setTimeout(() => { console.log('OAuth test timed out'); void mcp?.close(); server.close() }, 1200000)
server.listen(8765, '127.0.0.1', () => console.log('Open http://127.0.0.1:8765/ for the staging SSO check (no SMS).'))
