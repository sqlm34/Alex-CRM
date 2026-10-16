import { Pool } from '@neondatabase/serverless'
import testWorker from './test-entry'
import { bookingInput, persistPhoneBooking, verifyBookingAddress } from './booking'

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
        await client.query("insert into receptionist_calls(id,provider,provider_call_id,caller_phone) values($1,'retell',$1,$2)", [callId, input.phone])
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
          (select count(*) from receptionist_notifications where call_id=$2)::int as notifications`, [first.jobId, callId])
        if (Object.values(after.rows[0]).some(value => value !== 0)) throw Error('Rollback verification failed')
        return Response.json({ addressVerified: true, bookingPersistedWithinTransaction: true, replayPassed: true,
          separateJobTextPassed: true, notificationOutboxPassed: true, rollbackVerified: true, googleRequests: 1,
          customerNotificationsSent: false }, { headers: { 'Cache-Control': 'no-store' } })
      } finally {
        await client.query('rollback').catch(() => {})
        client.release()
      }
    } catch {
      return Response.json({ passed: false, stage }, { status: 503 })
    } finally { await pool.end() }
  },
}
