import type { NeonQueryFunction } from '@neondatabase/serverless'
import { ReceptionistError, object, exactKeys } from '../../shared/receptionist'
import { limitedBody } from './retell'
import { bookingCalendarFile, googleBookingCalendarUrl, type CalendarBooking } from '../../shared/bookingCalendar'

export type WebCallEnv = {
  RETELL_API_KEY?: string
  RETELL_WEBHOOK_API_KEY?: string
  RETELL_WEB_AGENT_ID?: string
  RETELL_WEB_AGENT_VERSION?: string
  RECEPTIONIST_WEB_ENABLED?: string
  RECEPTIONIST_WEB_ORIGINS?: string
  RECEPTIONIST_WEB_HASH_SECRET?: string
  TURNSTILE_SECRET_KEY?: string
}
export function webOrigin(request: Request, env: WebCallEnv) {
  const origin = request.headers.get('origin') || ''
  const allowed = (env.RECEPTIONIST_WEB_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (!origin || !allowed.includes(origin)) throw new ReceptionistError('Origin not allowed', 403)
  return origin
}
export function hasPhoneCapacity(value: unknown) {
  const p = object(value)
  return Number.isInteger(p.current_concurrency) && Number.isInteger(p.concurrency_limit)
    && Number(p.current_concurrency) >= 0 && Number(p.concurrency_limit) - Number(p.current_concurrency) >= 3
}
async function provider(env: WebCallEnv, path: string, body?: unknown) {
  const response = await fetch(`https://api.retellai.com${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${env.RETELL_WEBHOOK_API_KEY || env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new ReceptionistError('Voice booking temporarily unavailable', 503)
  return object(await response.json())
}
// No arbitrary proxy: callers cannot select an agent, override its tools, or monitor calls.
export async function startWebCall(request: Request, env: WebCallEnv, sql: NeonQueryFunction<false, false>) {
  const origin = webOrigin(request, env)
  if (request.method !== 'POST') throw new ReceptionistError('Method not allowed', 405)
  if (env.RECEPTIONIST_WEB_ENABLED !== 'true' || !(env.RETELL_WEBHOOK_API_KEY || env.RETELL_API_KEY) || !env.RETELL_WEB_AGENT_ID || !env.RETELL_WEB_AGENT_VERSION
    || !env.TURNSTILE_SECRET_KEY || !env.RECEPTIONIST_WEB_HASH_SECRET) throw new ReceptionistError('Voice booking is not enabled', 503)
  const input = object(JSON.parse(await limitedBody(request, 4096)))
  exactKeys(input, ['challenge'])
  if (typeof input.challenge !== 'string' || !input.challenge || input.challenge.length > 2048) throw new ReceptionistError('Verification required', 403)
  const ip = request.headers.get('cf-connecting-ip')
  if (!ip) throw new ReceptionistError('Verification unavailable', 503)
  const verified = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', signal: AbortSignal.timeout(5000), body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY, response: input.challenge, remoteip: ip,
    }),
  })
  const challenge = object(await verified.json())
  if (!verified.ok || challenge.success !== true || challenge.hostname !== new URL(origin).hostname || challenge.action !== 'voice_booking') throw new ReceptionistError('Verification failed', 403)
  return createAuthorizedWebCall(env, sql, ip)
}

// Used by the public challenge gate and the isolated, expiring owner test gate.
export async function recoverEndedWebLease(env: WebCallEnv, sql: NeonQueryFunction<false, false>) {
  const [session] = await sql.query(`select w.id,w.provider_call_id from receptionist_web_capacity c
    join receptionist_web_sessions w on w.id=c.session_id
    where c.singleton=true and c.lease_until>now() and w.agent_id=$1`, [env.RETELL_WEB_AGENT_ID])
  if (!session?.provider_call_id) return false
  try {
    const call = await provider(env, `/v2/get-call/${encodeURIComponent(String(session.provider_call_id))}`)
    if (call.call_id !== session.provider_call_id || call.agent_id !== env.RETELL_WEB_AGENT_ID
      || !['ended', 'error'].includes(String(call.call_status))) return false
    const released = await sql.query(`update receptionist_web_capacity set lease_until=now()
      where singleton=true and session_id=$1 returning session_id`, [session.id])
    return released.length > 0
  } catch { return false }
}

export async function createAuthorizedWebCall(env: WebCallEnv, sql: NeonQueryFunction<false, false>, ip: string) {
  if (env.RECEPTIONIST_WEB_ENABLED !== 'true' || !(env.RETELL_WEBHOOK_API_KEY || env.RETELL_API_KEY) || !env.RETELL_WEB_AGENT_ID || !env.RETELL_WEB_AGENT_VERSION || !env.RECEPTIONIST_WEB_HASH_SECRET) throw new ReceptionistError('Voice booking is not enabled', 503)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RECEPTIONIST_WEB_HASH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const minute = Math.floor(Date.now() / 60000)
  const hash = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${minute}:${ip}`))), byte => byte.toString(16).padStart(2, '0')).join('')
  const id = crypto.randomUUID()
  const acquire = () => sql.query(`update receptionist_web_capacity set session_id=$1,lease_until=now()+interval '12 minutes'
    where singleton=true and lease_until<=now() returning session_id`, [id])
  let lease = await acquire()
  if (!lease.length && await recoverEndedWebLease(env, sql)) lease = await acquire()
  if (!lease.length) throw new ReceptionistError('Voice assistant is busy. Please try again shortly.', 429)
  // Before creation begins it is safe to release our own lease on any rejection.
  try {
    const capacity = await provider(env, '/get-concurrency')
    if (!hasPhoneCapacity(capacity)) throw new ReceptionistError('Voice assistant is busy. Please use the booking form.', 429)
    // No daily quota. Only reject rapid automated starts; old daily buckets are ignored.
    const rows = await sql.query(`insert into receptionist_web_limits(bucket,used,expires_at) values($1,1,now()+interval '10 minutes')
      on conflict(bucket) do update set used=receptionist_web_limits.used+1 where receptionist_web_limits.used<$2 returning used`, [`burst:${minute}:${hash}`, 6])
    if (!rows.length) throw new ReceptionistError('Too many rapid voice starts. Please wait one minute and try again.', 429)
  } catch (error) {
    await sql.query('update receptionist_web_capacity set lease_until=now() where session_id=$1', [id])
    throw error
  }
  // One web call at a time. Do not release an uncertain creation: provider may have accepted it.
  await sql.query(`insert into receptionist_web_sessions(id,agent_id,expires_at) values($1,$2,now()+interval '12 minutes')`, [id, env.RETELL_WEB_AGENT_ID])
  const created = await provider(env, '/v3/create-web-call', {
    agent_id: env.RETELL_WEB_AGENT_ID, agent_version: env.RETELL_WEB_AGENT_VERSION,
    agent_override: { agent: { max_call_duration_ms: 600000 } },
  })
  if (typeof created.call_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(created.call_id) || typeof created.access_token !== 'string') throw new ReceptionistError('Voice connection could not be established', 503)
  await sql.query('update receptionist_web_sessions set provider_call_id=$2 where id=$1', [id, created.call_id])
  return { result_token: id, call_id: created.call_id, access_token: created.access_token, transport: created.transport, url: created.url,
    ice_servers: created.ice_servers, expires_at: created.expires_at }
}

// Short-lived capability delivered only to the browser that started this session.
export async function webBookingResult(request: Request, env: WebCallEnv, sql: NeonQueryFunction<false, false>) {
  webOrigin(request, env)
  if (request.method !== 'POST') throw new ReceptionistError('Method not allowed', 405)
  const input = object(JSON.parse(await limitedBody(request, 512)))
  exactKeys(input, ['token'])
  if (typeof input.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.token)) throw new ReceptionistError('Invalid session', 403)
  const [row] = await sql.query(`select j.id,j.address,j.appliance,left(j.service_date::text,10) as service_date,j.service_window,j.status,
    w.draft,c.outcome from receptionist_web_sessions w left join receptionist_calls c on c.provider_call_id=w.provider_call_id
    left join jobs j on j.id=c.job_id and j.status not in ('cancelled','canceled')
    where w.id=$1 and w.agent_id=$2 and w.created_at>now()-interval '1 hour'`, [input.token, env.RETELL_WEB_AGENT_ID])
  if (!row) return { confirmed: false }
  if (!row.id) return { confirmed: false, draft: row.draft || {}, callbackRecorded: row.outcome === 'callback_requested' }
  const job = row as CalendarBooking
  return { confirmed: true, date: String(job.service_date).slice(0, 10), window: job.service_window,
    draft: row.draft || {}, message: "We'll text you before heading to your address with our estimated arrival time.",
    calendarUrl: googleBookingCalendarUrl(job), calendarFile: bookingCalendarFile(job) }
}

export const webDraftFields = { appliance: 80, brand: 80, age: 80, issue: 1200, customer: 120, phone: 40, address: 300, zip: 10, date: 30, window: 60 } as const
export function webDraftInput(value: unknown) {
  const input = object(value)
  exactKeys(input, Object.keys(webDraftFields))
  const draft: Record<string, string> = {}
  for (const [key, limit] of Object.entries(webDraftFields)) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string' || input[key].length > limit) throw new ReceptionistError('Invalid draft field')
    draft[key] = input[key].trim()
  }
  return draft
}

export async function authorizedWebCall(value: unknown, env: WebCallEnv, sql: NeonQueryFunction<false, false>) {
  const call = object(value)
  if (!env.RETELL_WEB_AGENT_ID || call.call_type !== 'web_call' || call.agent_id !== env.RETELL_WEB_AGENT_ID
    || typeof call.call_id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(call.call_id)) throw new ReceptionistError('Call not authorized', 403)
  const [session] = await sql.query('select id from receptionist_web_sessions where provider_call_id=$1 and agent_id=$2', [call.call_id, env.RETELL_WEB_AGENT_ID])
  if (!session) throw new ReceptionistError('Call not authorized', 403)
  return { id: call.call_id, caller: '', destination: '', provider: 'retell' as const, ended: ['ended', 'error'].includes(String(call.call_status)), channel: 'web' as const }
}
