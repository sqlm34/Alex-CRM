import { googleActionsConfig, merchantChanged, validateGoogleAttribution, type GoogleActionsEnv } from './googleActionsConfig'

export type GoogleActionsSql = { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }
const maxAttempts = 5
const timeoutMs = 8000
const captureWindows = new Map<string, { count: number; until: number }>()

// Per-isolate abuse bound only, not a distributed WAF/rate-limit guarantee.
export function allowGoogleCapture(key: string, now = Date.now()) {
  for (const [entry, value] of captureWindows) if (value.until <= now) captureWindows.delete(entry)
  const window = captureWindows.get(key)
  if (window) { window.count += 1; return window.count <= 20 }
  if (captureWindows.size >= 4096) return false
  captureWindows.set(key, { count: 1, until: now + 60000 })
  return true
}

export async function readGoogleCaptureBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return { status: 400, input: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 131072) { void reader.cancel().catch(() => {}); return { status: 413, input: null } }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { status: 200, input: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  }
  try {
    return await Promise.race([read(), new Promise<{ status: number; input: unknown }>(resolve => {
      timer = setTimeout(() => { void reader.cancel().catch(() => {}); resolve({ status: 408, input: null }) }, 5000)
    })])
  } catch (error) {
    if (error instanceof SyntaxError) return { status: 400, input: null }
    throw error
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function captureGoogleAttribution(sql: GoogleActionsSql, env: GoogleActionsEnv, input: unknown) {
  const config = googleActionsConfig(env)
  if (!config) return null
  const attribution = validateGoogleAttribution(input, config)
  if (!attribution) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    config.environment, config.deployment, config.partnerId, attribution.merchantId, attribution.token,
  ])))
  const captureKey = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  const rows = await sql.query(
    `insert into google_actions_attributions
       (id, capture_key, environment, deployment, partner_id, merchant_id, rwg_token, captured_at, expires_at)
     values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::timestamptz)
     on conflict (capture_key) do update set capture_key = excluded.capture_key
     where google_actions_attributions.expires_at > now() and google_actions_attributions.rwg_token is not null
     returning id as attribution_id, captured_at, expires_at`,
    [crypto.randomUUID(), captureKey, config.environment, config.deployment, config.partnerId, attribution.merchantId,
      attribution.token, new Date(attribution.capturedAt).toISOString(), new Date(attribution.expiresAt).toISOString()],
  )
  return rows[0] || null
}

export async function enqueueGoogleConversion(sql: GoogleActionsSql, env: GoogleActionsEnv, attributionId: unknown, sessionId: string, jobId: string) {
  const config = googleActionsConfig(env)
  if (!config || typeof attributionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attributionId)) return false
  // One statement makes the safe label and durable outbox entry atomic. Never put the token on jobs.
  const rows = await sql.query(
    `with queued as (
      insert into google_actions_conversions (job_id, session_id, attribution_id, environment, deployment, partner_id, merchant_id)
      select $1::text, $2::text, a.id, a.environment, a.deployment, a.partner_id, $7::text
      from google_actions_attributions a
      where a.id = $3::text and a.environment = $4::text and a.deployment = $5::text and a.partner_id = $6::text
        and a.merchant_id = $7::text and a.expires_at > now() and a.captured_at <= now() and a.rwg_token is not null
        and exists (select 1 from booking_sessions s where s.id = $2::text and s.job_id = $1::text)
      on conflict do nothing returning job_id
    ) update jobs set booking_source = 'google', booking_source_detail = 'actions_center'
      where id in (select job_id from queued) returning id`,
    [jobId, sessionId, attributionId, config.environment, config.deployment, config.partnerId, config.merchantId],
  )
  return rows.length > 0
}

export function googleConversionOutcome(status: number | null, attempt: number) {
  if (status !== null && status >= 200 && status < 300) return { status: 'sent', error: null }
  if (status === 429) return { status: attempt < maxAttempts ? 'pending' : 'failed_terminal', error: 'rate_limited' }
  // Google documents no remote idempotency key. Timeout, worker death, and 5xx may follow acceptance.
  // Do not auto-replay these ambiguous deliveries or claim end-to-end exactly-once.
  if (status === null || status >= 500 || status === 408) return { status: 'ambiguous', error: 'delivery_unknown' }
  return { status: 'failed_terminal', error: 'request_rejected' }
}

export async function processGoogleConversions(sql: GoogleActionsSql, env: GoogleActionsEnv, send: typeof fetch = fetch) {
  const config = googleActionsConfig(env)
  if (!config) return
  const scope = [config.environment, config.deployment, config.partnerId]
  await sql.query(
    `update google_actions_conversions set status = 'ambiguous', last_error = 'lease_expired', lease_id = null
     where environment = $1::text and deployment = $2::text and partner_id = $3::text and status = 'sending' and lease_until < now()`, scope,
  )
  await sql.query(
    `update google_actions_attributions set rwg_token = null
     where environment = $1::text and deployment = $2::text and partner_id = $3::text and expires_at <= now() and rwg_token is not null`, scope,
  )
  await sql.query(
    `update google_actions_conversions c set status = 'failed_terminal', last_error = 'attribution_expired'
     from google_actions_attributions a where c.attribution_id = a.id
     and c.environment = $1::text and c.deployment = $2::text and c.partner_id = $3::text
     and c.status = 'pending' and a.expires_at <= now()`, scope,
  )
  // Claim one at a time: every lease starts immediately before its bounded HTTP operation.
  for (let batch = 0; batch < 3; batch += 1) {
    const leaseId = crypto.randomUUID()
    const rows = await sql.query(
      `with candidate as (
        select c.job_id from google_actions_conversions c
        join google_actions_attributions a on a.id = c.attribution_id
        where c.environment = $1::text and c.deployment = $2::text and c.partner_id = $3::text and c.merchant_id = $4::text
          and c.status = 'pending' and c.next_attempt_at <= now() and c.attempts < $5::int
          and a.expires_at > now() and a.rwg_token is not null
        order by c.next_attempt_at, c.job_id for update of c skip locked limit 1
      ), claimed as (
        update google_actions_conversions c set status = 'sending', attempts = c.attempts + 1,
          lease_id = $6::text, lease_until = now() + interval '2 minutes', last_attempt_at = now()
        from candidate where c.job_id = candidate.job_id
        returning c.job_id, c.attribution_id, c.attempts, c.merchant_id
      ) select c.job_id, c.attempts, c.merchant_id, a.merchant_id as original_merchant_id, a.rwg_token
        from claimed c join google_actions_attributions a on a.id = c.attribution_id`,
      [...scope, config.merchantId, maxAttempts, leaseId],
    )
    const row = rows[0]
    if (!row) break
    let responseStatus: number | null = null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await send(config.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ conversion_partner_id: config.partnerId, rwg_token: row.rwg_token,
          merchant_changed: row.merchant_id === row.original_merchant_id ? merchantChanged.ORIGINAL_MERCHANT : merchantChanged.DIFFERENT_MERCHANT }),
      })
      responseStatus = response.status
      await response.body?.cancel()
    } catch {
      // Never log request, response body, thrown network/DB errors, or attribution tokens.
    } finally {
      clearTimeout(timeout)
    }
    const outcome = googleConversionOutcome(responseStatus, Number(row.attempts))
    await sql.query(
      `update google_actions_conversions set status = $3::text, last_error = $4::text, lease_id = null, lease_until = null,
         sent_at = case when $3::text = 'sent' then now() else sent_at end,
         next_attempt_at = now() + ($5::int * interval '1 second')
       where job_id = $1::text and lease_id = $2::text and status = 'sending'`,
      [row.job_id, leaseId, outcome.status, outcome.error, Math.min(3600, 60 * 2 ** (Number(row.attempts) - 1))],
    )
  }
}

export async function safelyEnqueueGoogleConversion(sql: GoogleActionsSql, env: GoogleActionsEnv, attributionId: unknown, sessionId: string, jobId: string) {
  try { return await enqueueGoogleConversion(sql, env, attributionId, sessionId, jobId) } catch { return false }
}

export async function safelyProcessGoogleConversions(sql: GoogleActionsSql, env: GoogleActionsEnv) {
  try { await processGoogleConversions(sql, env) } catch { /* Booking and cron must not expose protected DB errors. */ }
}
