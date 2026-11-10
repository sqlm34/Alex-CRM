import { Pool } from '@neondatabase/serverless'
import testWorker from './test-entry'
import { bookingInput, persistPhoneBooking, verifyBookingAddress } from './booking'
import { receptionistRoute } from './routes'
import { defaultReceptionistSettings } from '../../shared/receptionist'

type Env = Parameters<typeof testWorker.fetch>[1] & {
  RECEPTIONIST_PROBE_HASH?: string
  RECEPTIONIST_PROBE_EXPIRES?: string
}

// Temporary deployment entry only. The normal entry never imports this module.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname !== '/_receptionist-live-probe') return testWorker.fetch(request, env, ctx)
    const expires = Number(env.RECEPTIONIST_PROBE_EXPIRES)
    if (request.method !== 'POST' || env.AI_RECEPTIONIST_DEPLOYMENT !== 'preview'
      || !env.RECEPTIONIST_TEST_DATABASE_URL || !env.AI_RECEPTIONIST_GEOCODING_KEY
      || !Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 600_000
      || !/^[a-f0-9]{64}$/.test(env.RECEPTIONIST_PROBE_HASH || '')) return new Response('Not found', { status: 404 })
    const token = request.headers.get('authorization') || ''
    if (!/^Bearer [a-f0-9]{64}$/.test(token)) return new Response('Forbidden', { status: 403 })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.slice(7)))
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    if (hash !== env.RECEPTIONIST_PROBE_HASH) return new Response('Forbidden', { status: 403 })
    const hostname = new URL(env.RECEPTIONIST_TEST_DATABASE_URL).hostname
    if (hostname !== 'ep-shiny-wildflower-b4370jck-pooler.c-6.us-east-2.aws.neon.tech') return new Response('Wrong database', { status: 409 })
    const pool = new Pool({ connectionString: env.RECEPTIONIST_TEST_DATABASE_URL, max: 1 })
    let stage = 'database_connection'
    try {
      const client = await pool.connect()
      try {
        // Commit only a one-use marker. Every booking-related write is rolled back.
        await client.query('begin')
        await client.query("set local lock_timeout='3000ms'")
        await client.query("select pg_advisory_xact_lock(hashtext('receptionist-live-probe'))")
        const prior = await client.query("select 1 from receptionist_audit where action='live_probe_started' and actor_id=$1", [hash])
        if (prior.rows.length) {
          await client.query('rollback')
          return Response.json({ repeated: true }, { status: 409 })
        }
        await client.query("insert into receptionist_audit(action,actor_id) values('live_probe_started',$1)", [hash])
        await client.query('commit')
        stage = 'google_address'
        const input = bookingInput({ customer: 'TEST ROLLBACK ONLY', phone: '+13175550142',
          address: '1 Civic Square, Carmel, IN', zip: '46032',
          service: { appliance: 'Washer repair', issue: 'Synthetic test only', diagnosis: 'unknown', requestedService: 'diagnostic' },
          date: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10), window: '9:00 AM - 11:00 AM', confirmed: true })
        // Exactly one paid Google request per run; no automatic retries.
        const location = await verifyBookingAddress(input, env.AI_RECEPTIONIST_GEOCODING_KEY)
        stage = 'booking_transaction'
        const callId = `retell:probe_${crypto.randomUUID()}`
        await client.query('begin isolation level serializable')
        await client.query("set local statement_timeout='8000ms'")
        await client.query("set local lock_timeout='3000ms'")
        // Synthetic policy is scoped to this rolled-back test transaction only.
        await client.query(`create table if not exists receptionist_deleted_calls(call_id text primary key,deleted_at timestamptz default now());
          alter table receptionist_calls add column if not exists location_city text;
          alter table receptionist_calls add column if not exists location_zip text`)
        await client.query(`alter table jobs drop constraint if exists jobs_booking_source_detail_check;
          alter table jobs add constraint jobs_booking_source_detail_check check
          (booking_source_detail is null or booking_source_detail in ('actions_center','voice_assistant','phone_assistant','mcp_assistant'))`)
        await client.query('update receptionist_settings set settings=$1::jsonb where singleton=true', [JSON.stringify({
          ...defaultReceptionistSettings, enabled: true, testMode: true, publicPhone: env.RETELL_TEST_PHONE,
          serviceZips: ['46032', '46033'], zipOnlyZips: ['46032', '46033'],
        })])
        await client.query("insert into receptionist_calls(id,provider,provider_call_id,caller_phone) values($1,'retell',$1,$2)", [callId, input.phone])
        stage = 'signed_tool_routes'
        const routeTimes: Record<string, number> = {}
        const webhookKey = env.RETELL_WEBHOOK_API_KEY || crypto.randomUUID()
        const invoke = async (tool: string, args: unknown) => {
          const raw = JSON.stringify({ call: { call_id: callId.slice(7), agent_id: env.RETELL_AGENT_ID,
            to_number: env.RETELL_TEST_PHONE, from_number: input.phone, direction: 'inbound', call_type: 'phone_call', call_status: 'ongoing' }, args })
          const stamp = String(Date.now())
          stage = `signed_${tool}`
          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(webhookKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw + stamp))), b => b.toString(16).padStart(2, '0')).join('')
          const begin = Date.now()
          const result = await receptionistRoute(new Request(`https://example.com/api/receptionist/providers/retell/tools/${tool}`, {
            method: 'POST', body: raw, headers: { 'x-retell-signature': `v=${stamp},d=${signature}` },
          }), { ...env, RETELL_WEBHOOK_API_KEY: webhookKey, AI_RECEPTIONIST_ENABLED: 'true' }, { sql: { query: async (text: string, values?: unknown[]) => (await client.query(text, values)).rows } as never,
            owner: async () => { throw Error('Unexpected owner access') }, availability: async () => [], book: async () => { throw Error('Unexpected booking') } })
          routeTimes[tool] = Date.now() - begin
          stage = `signed_${tool}_${result.status}`
          return result
        }
        const covered = await invoke('checkServiceArea', { zip: '46033', address: '' })
        if (covered.status !== 200 || !(covered.value as { covered?: boolean }).covered) throw Error('ZIP test failed')
        const outside = await invoke('checkServiceArea', { zip: '99999', address: '' })
        if (outside.status !== 200 || (outside.value as { covered?: boolean }).covered) throw Error('Outside ZIP test failed')
        const callback = { customer: 'TEST Callback', phone: input.phone, reason: 'Synthetic callback only', confirmed: true }
        if ((await invoke('requestCallback', callback)).status !== 200 || (await invoke('requestCallback', callback)).status !== 200) throw Error('Callback test failed')
        if ((await client.query('select count(*)::int as n from receptionist_callbacks where call_id=$1', [callId])).rows[0].n !== 1) throw Error('Callback duplicate')
        stage = 'booking_transaction'
        const context = { callId, input, locate: async () => location, newJobId: `TEST-${crypto.randomUUID()}`,
          requireLeadTime: () => { if (Date.parse(input.date) < Date.now() + 86400_000) throw Error('Test date must be future') } }
        const query = (text: string, values?: unknown[]) => client.query(text, values)
        const first = await persistPhoneBooking(query, context)
        stage = 'booking_replay'
        const replay = await persistPhoneBooking(query, context)
        if (!first.confirmed || !replay.replay || replay.jobId !== first.jobId) throw Error('Replay failed')
        const rows = await client.query('select job_text,details from jobs where id=$1', [first.jobId])
        if (rows.rows.length !== 1 || rows.rows[0].job_text !== '' || rows.rows[0].details !== '') throw Error('Job fields failed')
        const outbox = await client.query('select count(*)::int as n from receptionist_notifications where call_id=$1', [callId])
        if (outbox.rows[0].n !== 1) throw Error('Outbox failed')
        await client.query('rollback')
        stage = 'rollback_verification'
        const after = await client.query(`select (select count(*) from jobs where id=$1)::int as jobs,
          (select count(*) from receptionist_calls where id=$2)::int as calls,
          (select count(*) from receptionist_callbacks where call_id=$2)::int as callbacks,
          (select count(*) from receptionist_notifications where call_id=$2)::int as notifications`, [first.jobId, callId])
        if (Object.values(after.rows[0]).some(value => value !== 0)) throw Error('Rollback verification failed')
        return Response.json({ addressVerified: true, bookingPersistedWithinTransaction: true, replayPassed: true,
          separateJobTextPassed: true, notificationOutboxPassed: true, rollbackVerified: true, googleRequests: 1,
          callbackDeduplicated: true, signedZipChecksPassed: true, routeTimes,
          customerNotificationsSent: false }, { headers: { 'Cache-Control': 'no-store' } })
      } finally {
        await client.query('rollback').catch(() => {})
        client.release()
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      const constraint = (error as { constraint?: string }).constraint
      return Response.json({ passed: false, stage, databaseCode: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null,
        constraint: typeof constraint === 'string' && /^[a-z_]{1,100}$/.test(constraint) ? constraint : null }, { status: 503 })
    } finally { await pool.end() }
  },
}
