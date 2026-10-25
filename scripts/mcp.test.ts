import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { createBackend } from '../worker/mcp/backend'
import { mcpRoute } from '../worker/mcp/server'
import { bookingInput, slotsInput } from '../worker/mcp/schemas'
import { defaultReceptionistSettings } from '../shared/receptionist'
import { authenticate } from '../worker/mcp/security'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import pg from 'pg'

const owner = { id: 'owner', phone: '+13175550142', scopes: ['booking:create', 'booking:read', 'booking:cancel'] }
const input = () => bookingInput.parse({ customer: 'TEST Customer', phone: owner.phone, email: 'test@example.com',
  address: '1 Civic Square, Carmel, IN', zip: '46032', date: '2027-01-12', window: '9:00 AM - 11:00 AM',
  service: { appliance: 'Washer repair', issue: 'Does not drain', diagnosis: 'unknown', requestedService: 'repair' },
  confirmed: true, idempotencyKey: crypto.randomUUID() })
async function fixture() {
  let db: Pick<PGlite, 'exec' | 'query' | 'transaction' | 'close'>
  if (process.env.MCP_TEST_PG_PORT) {
    const schema = `mcp_test_${crypto.randomUUID().replaceAll('-', '')}`
    const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.MCP_TEST_PG_PORT), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', options: `-c search_path=${schema}`, max: 8 })
    await pool.query(`create schema ${schema}`)
    db = {
      exec: (sql: string) => pool.query(sql), query: (sql: string, values: unknown[]) => pool.query(sql, values),
      transaction: async (run: any) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const client = await pool.connect()
          try {
            await client.query('begin isolation level serializable')
            const result = await run({ query: (sql: string, values: unknown[]) => client.query(sql, values) })
            await client.query('commit'); return result
          } catch (error) {
            await client.query('rollback')
            if (!['40001', '40P01'].includes((error as any).code) || attempt === 2) throw error
          } finally { client.release() }
        }
      },
      close: async () => { await pool.query(`drop schema ${schema} cascade`); await pool.end() },
    } as unknown as typeof db
  } else { db = new PGlite() }
  await db.exec(`create table jobs(id text primary key,customer text,phone text,email text,address text,appliance text,issue text,
    details text,job_text text,service_date date,service_window text,status text,invoice numeric,paid boolean,finance_items jsonb,
    payments jsonb,model_photo_attachments jsonb,lat numeric,lng numeric,created_by_user_id text,booking_source text,booking_source_detail text);
    create table booking_sessions(id text primary key,job_id text,created_at timestamptz default now(),updated_at timestamptz default now());
    create table booking_risk_events(id text primary key,session_id text,job_id text,event text,risk_score int,decision text,reasons jsonb);
    create table availability_blocks(blocked_date date,all_day boolean,service_window text);
    create table receptionist_settings(singleton boolean primary key,settings jsonb,revision int);`)
  await db.exec(readFileSync(new URL('../migrations/2026-09-09_add_booking_requests.sql', import.meta.url), 'utf8').replaceAll('public.', ''))
  await db.exec(readFileSync(new URL('../migrations/2026-10-25_mcp_booking.sql', import.meta.url), 'utf8'))
  await db.query('insert into receptionist_settings values(true,$1::jsonb,0)', [JSON.stringify({ ...defaultReceptionistSettings,
    serviceZips: ['46032', '46240'], zipOnlyZips: ['46032'], diagnosticFee: '$89', transferPhone: '+13175550143' })])
  const notifications: unknown[] = []
  const deps = {
    query: async (text: string, values?: unknown[]) => (await db.query(text, values)).rows as any[],
    transaction: async <T>(run: (query: any) => Promise<T>) => db.transaction(async tx => run(async (text: string, values?: unknown[]) => (await tx.query(text, values)).rows)),
    availability: async () => ['9:00 AM - 11:00 AM'], leadTime: () => {},
    locate: async () => { throw Error('Geocoder down') },
    createSession: async () => { const id = crypto.randomUUID(); await db.query('insert into booking_sessions(id) values($1)', [id]); return id },
    checkRisk: async () => {}, newJobId: () => `J-${crypto.randomUUID()}`, notify: (job: unknown) => { notifications.push(job) },
    notificationEnv: {}, confirmationUrl: 'https://example.com/mcp/confirm',
  }
  const backend = createBackend(deps)
  const approve = async (details: any, action: 'createBooking' | 'cancelBooking' = 'createBooking') => backend.approve({ action, details, device_id: 'test-device-123', started_at: Date.now() - 20000, turnstile_token: 'synthetic', website: '' }, owner, new Request('https://example.com'))
  return { db, backend, deps, approve, notifications }
}
test('MCP uses live policies without exposing private transfer configuration', async () => {
  const f = await fixture()
  try {
    const policy = await f.backend.execute('getBusinessPolicies', {}, null)
    assert.equal(policy.diagnosticFee, '$89')
    assert.ok(!JSON.stringify(policy).includes('+13175550143'))
    assert.equal((await f.backend.execute('checkServiceArea', { zip: '46032', address: '' }, null)).covered, true)
    assert.equal((await f.backend.execute('checkServiceArea', { zip: '90210', address: '' }, null)).covered, false)
    assert.equal((await f.backend.execute('checkServiceArea', { zip: '46240', address: 'Some full street address' }, null)).covered, false)
    f.deps.availability = async () => []
    assert.deepEqual((await f.backend.execute('getAvailableSlots', slotsInput.strip().parse(input()), null)).windows, [])
  } finally { await f.db.close() }
})
test('confirmed booking, idempotency, ownership, cancellation and deletion tombstones', async () => {
  const f = await fixture()
  try {
    const details = input()
    const pending = await f.backend.execute('createBooking', details, owner)
    assert.equal(pending.confirmed, false)
    assert.equal(pending.confirmationRequired, true)
    assert.equal((await f.deps.query('select * from jobs')).length, 0)
    const token = await f.approve(details)
    const booked = await f.backend.execute('createBooking', { ...details, confirmationToken: token.confirmationToken }, owner)
    assert.equal(booked.confirmed, true)
    assert.equal(booked.date, details.date)
    assert.equal(f.notifications.length, 1)
    assert.deepEqual(await f.backend.execute('createBooking', details, owner), booked)
    assert.equal(f.notifications.length, 1)
    await assert.rejects(f.backend.execute('createBooking', { ...details, customer: 'Changed' }, owner), /idempotency_conflict/)
    await assert.rejects(f.backend.execute('getBookingStatus', { bookingId: booked.bookingId }, { ...owner, id: 'stranger' }), /booking_not_found/)
    await assert.rejects(f.backend.execute('cancelBooking', { bookingId: booked.bookingId, confirmed: true, idempotencyKey: crypto.randomUUID() }, { ...owner, id: 'stranger' }), /booking_not_found/)
    const cancel = { bookingId: booked.bookingId, confirmed: true as const, idempotencyKey: crypto.randomUUID() }
    await f.approve(cancel, 'cancelBooking')
    assert.equal((await f.backend.execute('cancelBooking', cancel, owner)).canceled, true)
    await f.db.query('delete from jobs where id=$1', [booked.bookingId])
    await assert.rejects(f.backend.execute('createBooking', details, owner), /booking_not_found/)
    assert.equal((await f.deps.query('select * from jobs')).length, 0)
  } finally { await f.db.close() }
})
test('shared persistence rejects occupied time, time off, changed confirmation and blocked risk', async () => {
  const f = await fixture()
  try {
    const details = input(); const token = await f.approve(details)
    await assert.rejects(f.backend.execute('createBooking', { ...details, customer: 'Tampered', confirmationToken: token.confirmationToken }, owner), /customer_confirmation_required/)
    await f.db.query("insert into availability_blocks values($1,true,null)", [details.date])
    await assert.rejects(f.backend.execute('createBooking', details, owner), /slot_unavailable/)
    assert.equal((await f.deps.query('select * from booking_requests')).length, 0)
    await f.db.exec('delete from availability_blocks')
    await f.db.query('insert into jobs(id,service_date,service_window,status) values($1,$2,$3,$4)', ['WEBSITE-JOB', details.date, details.window, 'scheduled'])
    await assert.rejects(f.backend.execute('createBooking', details, owner), /slot_unavailable/)
    await f.db.exec('delete from jobs')
    f.deps.checkRisk = async () => { throw Error('blocked') }
    await assert.rejects(f.backend.execute('createBooking', details, owner), /blocked/)
    assert.equal((await f.deps.query('select * from jobs')).length, 0)
  } finally { await f.db.close() }
})
test('simultaneous MCP requests cannot double-book and expired approvals cannot authorize', async () => {
  const f = await fixture()
  try {
    const first = input(), second = input()
    await f.approve(first); await f.approve(second)
    const results = await Promise.allSettled([
      f.backend.execute('createBooking', first, owner), f.backend.execute('createBooking', second, owner),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal((await f.deps.query('select * from jobs')).length, 1)
    assert.equal(f.notifications.length, 1)
    const third = { ...input(), date: '2027-01-13' }
    const token = await f.approve(third)
    await f.db.exec("update mcp_approvals set expires_at=now()-interval '1 second'")
    await assert.rejects(f.backend.execute('createBooking', { ...third, confirmationToken: token.confirmationToken }, owner), /customer_confirmation_required/)
    for (let i = 0; i < 60; i++) assert.equal(await f.backend.limit('synthetic-limit'), true)
    assert.equal(await f.backend.limit('synthetic-limit'), false)
  } finally { await f.db.close() }
})
test('Streamable HTTP initialization, schemas, challenges, origin and body limits', async () => {
  const f = await fixture()
  const env = { MCP_ENABLED: 'true', MCP_RESOURCE_URL: 'https://example.com/mcp', MCP_OAUTH_ISSUER: 'https://issuer.example' }
  const request = (body: unknown, headers = {}) => new Request('https://example.com/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
  try {
    assert.equal((await mcpRoute(request({}), {}, f.backend)).status, 404)
    assert.equal((await mcpRoute(request({}, { Origin: 'https://evil.example' }), env, f.backend)).status, 403)
    const initialized = await mcpRoute(request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }), env, f.backend)
    assert.equal(initialized.status, 200)
    const list = await (await mcpRoute(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), env, f.backend)).json() as any
    assert.equal(list.result.tools.length, 8)
    const denied = await mcpRoute(request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'getBookingStatus', arguments: { bookingId: 'other' } } }), env, f.backend)
    assert.equal(denied.status, 401)
    assert.match(denied.headers.get('WWW-Authenticate')!, /booking:read/)
    assert.equal((await mcpRoute(request({ junk: 'a'.repeat(33000) }), env, f.backend)).status, 413)
    await assert.rejects(authenticate(new Request('https://example.com', { headers: { Authorization: 'Basic secret' } }), env), /invalid_token/)
  } finally { await f.db.close() }
})
test('official SDK client can discover and call the Streamable HTTP server', async () => {
  const f = await fixture()
  const client = new Client({ name: 'official-sdk-test', version: '1.0.0' })
  const env = { MCP_ENABLED: 'true', MCP_RESOURCE_URL: 'https://example.com/mcp' }
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(env.MCP_RESOURCE_URL), {
      fetch: async (url, init) => mcpRoute(new Request(url, init), env, f.backend),
    }))
    assert.equal((await client.listTools()).tools.length, 8)
    const response = await client.callTool({ name: 'checkServiceArea', arguments: { zip: '46032' } })
    assert.equal((response.structuredContent as any).covered, true)
    f.deps.query = async () => { throw Error('DATABASE_URL=must-not-leak') }
    const failure = await client.callTool({ name: 'getBusinessPolicies', arguments: {} }).catch(error => error)
    assert.ok(!JSON.stringify(failure).includes('must-not-leak'))
  } finally { await client.close(); await f.db.close() }
})
test('OAuth rejects expired, wrong audience/issuer and unsigned tokens; identity uses verified phone', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' }
  const env = { MCP_RESOURCE_URL: 'https://example.com/mcp', MCP_OAUTH_ISSUER: 'https://issuer-test.example', MCP_OAUTH_JWKS_URL: 'https://issuer-test.example/jwks' }
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ keys: [jwk] })
  const sign = (claims = {}, audience = env.MCP_RESOURCE_URL, issuer = env.MCP_OAUTH_ISSUER, expiration: string | number = '5m') => new SignJWT({ scope: 'booking:create', phone_number: owner.phone, phone_number_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('customer').setIssuedAt().setIssuer(issuer).setAudience(audience).setExpirationTime(expiration).sign(privateKey)
  const read = async (token: string) => authenticate(new Request(env.MCP_RESOURCE_URL, { headers: { Authorization: `Bearer ${token}` } }), env)
  try {
    assert.equal((await read(await sign()))?.phone, owner.phone)
    assert.equal((await read(await sign({ phone_number_verified: false })))?.phone, '')
    await assert.rejects(read(await sign({}, 'https://other.example')), /invalid_token/)
    await assert.rejects(read(await sign({}, undefined, 'https://other.example')), /invalid_token/)
    await assert.rejects(read(await sign({}, undefined, undefined, 1)), /invalid_token/)
    await assert.rejects(read('unsigned.invalid.token'), /invalid_token/)
  } finally { globalThis.fetch = original }
})
