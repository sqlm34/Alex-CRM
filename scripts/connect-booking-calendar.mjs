import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// One-time owner authorization. Tokens never enter the repository or console logs.
const credentials = JSON.parse(readFileSync(process.argv[2], 'utf8')).web
if (!credentials?.client_id || !credentials?.client_secret) throw Error('Expected web OAuth credentials')
const dir = join(homedir(), '.alex-booking-calendar')
mkdirSync(dir, { recursive: true })
const state = randomBytes(32).toString('hex')
const verifier = randomBytes(48).toString('base64url')
const redirect = 'http://localhost:8766/oauth/callback'
const params = new URLSearchParams({ client_id: credentials.client_id, redirect_uri: redirect,
  response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.events.owned',
  access_type: 'offline', prompt: 'consent', login_hint: 'alexeasyrepair@gmail.com', state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
let used = false
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (req.headers.host !== 'localhost:8766') { res.writeHead(403).end(); return }
  const url = new URL(req.url, 'http://localhost:8766')
  if (url.pathname === '/start') {
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }).end(); return
  }
  if (url.pathname !== '/oauth/callback' || used || url.searchParams.get('state') !== state) {
    res.writeHead(400).end('Invalid authorization request'); return
  }
  if (!url.searchParams.get('code')) { res.writeHead(400).end('Authorization was not granted'); return }
  used = true
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: credentials.client_id,
        client_secret: credentials.client_secret, code: url.searchParams.get('code'),
        redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) })
    const token = await response.json()
    if (!response.ok || !token.refresh_token) throw Error('No offline authorization token received')
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      BOOKING_CALENDAR_ID: 'alexeasyrepair@gmail.com', BOOKING_CALENDAR_CLIENT_ID: credentials.client_id,
      BOOKING_CALENDAR_CLIENT_SECRET: credentials.client_secret, BOOKING_CALENDAR_REFRESH_TOKEN: token.refresh_token
    }), { mode: 0o600 })
    res.end('Calendar authorization saved securely. You may close this tab.')
    console.log('Calendar authorization saved; no customer messages sent.')
  } catch { res.writeHead(500).end('Authorization failed. Restart the connector and try again.') }
  server.close()
})
server.listen(8766, 'localhost', () => console.log('Owner authorization ready at http://localhost:8766/start'))
setTimeout(() => server.close(), 30 * 60 * 1000).unref()
