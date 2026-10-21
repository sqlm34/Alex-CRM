import type { NeonQueryFunction } from '@neondatabase/serverless'
import { calendarDate, defaultReceptionistSettings, exactKeys, object, phoneNumber, receptionistTools, ReceptionistError, serviceEligibility, serviceRequest, textField, validateReceptionistSettings } from '../../shared/receptionist'
import { limitedBody, retellCall, retellMetrics, verifyRetell } from './retell'
import { bookingInput, type PhoneBooking } from './booking'
import { liveModeAllowed, settingsModeAllowed } from './mode'

export type ReceptionistEnv = {
  AI_RECEPTIONIST_ENABLED?: string
  AI_RECEPTIONIST_LIVE_ENABLED?: string
  RETELL_API_KEY?: string
  RETELL_WEBHOOK_API_KEY?: string
  RETELL_AGENT_ID?: string
  RETELL_TEST_PHONE?: string
  AI_RECEPTIONIST_BOOKING_ENABLED?: string
  AI_RECEPTIONIST_BOOKING_TEST_UNTIL?: string
  AI_RECEPTIONIST_DEPLOYMENT?: string
  AI_RECEPTIONIST_GEOCODING_KEY?: string
  AI_RECEPTIONIST_PUSH_ENABLED?: string
}
type Dependencies = {
  sql: NeonQueryFunction<false, false>
  owner: () => Promise<string>
  availability: (date: string) => Promise<string[]>
  book: (callId: string, input: PhoneBooking) => Promise<unknown>
  testPush?: (actor: string) => Promise<unknown>
}
const response = (value: unknown, status = 200) => ({ value, status })
export const bookingEnabled = (env: ReceptionistEnv) => env.AI_RECEPTIONIST_ENABLED === 'true' && env.AI_RECEPTIONIST_BOOKING_ENABLED === 'true'
  && Boolean(env.AI_RECEPTIONIST_GEOCODING_KEY) && (liveModeAllowed(env)
    || (env.AI_RECEPTIONIST_DEPLOYMENT === 'preview'
      && Number(env.AI_RECEPTIONIST_BOOKING_TEST_UNTIL) > Date.now()
      && Number(env.AI_RECEPTIONIST_BOOKING_TEST_UNTIL) <= Date.now() + 3600_000))

export async function receptionistRoute(request: Request, env: ReceptionistEnv, deps: Dependencies) {
  const path = new URL(request.url).pathname.slice('/api/receptionist'.length)
  const { sql } = deps
  const actor = path.startsWith('/providers/') ? null : await deps.owner()
  let stage = 'configuration'
  try {
    if (!path.startsWith('/providers/')) {
      if (path === '/test-push' && request.method === 'POST') {
        if (!deps.testPush || !actor) throw new ReceptionistError('Notification check unavailable', 503)
        const input = object(JSON.parse(await limitedBody(request, 1024)))
        exactKeys(input, ['confirmed'])
        if (input.confirmed !== true) throw new ReceptionistError('Confirm the notification check')
        return response(await deps.testPush(actor))
      }
      if (path === '/diagnostics' && request.method === 'GET') {
        const [schema] = await sql.query("select to_regclass('receptionist_settings') is not null as ready")
        const [connection] = schema.ready ? await sql.query('select max(started_at) as last_signed_call_at from receptionist_calls') : []
        const [configuration] = schema.ready ? await sql.query('select settings from receptionist_settings where singleton=true') : []
        const active = configuration?.settings?.enabled === true
          && typeof configuration.settings.testMode === 'boolean'
          && settingsModeAllowed(env, configuration.settings.testMode)
        return response({ schemaReady: Boolean(schema.ready), environmentEnabled: env.AI_RECEPTIONIST_ENABLED === 'true',
          retellConfigured: Boolean(env.RETELL_WEBHOOK_API_KEY && env.RETELL_AGENT_ID && env.RETELL_TEST_PHONE),
          bookingEnabled: Boolean(active && bookingEnabled(env)), smsEnabled: false, recordingsEnabled: false, providerRecordingVerified: false, mode: liveModeAllowed(env) ? 'production' : 'test_only',
          lastSignedCallAt: connection?.last_signed_call_at ?? null,
          liveVerification: connection?.last_signed_call_at ? 'Signed call received; full booking test still required' : 'No signed calls received' })
      }
      if (path === '/stats' && request.method === 'GET') {
        const [stats] = await sql.query(`select count(*)::int as total_calls,
          count(*) filter (where job_id is not null)::int as booked_calls,
          count(cost_cents)::int as priced_calls,sum(cost_cents) as recorded_cost_cents,
          avg(latency_ms) as mean_call_median_latency_ms,
          (select count(*)::int from receptionist_callbacks where status='pending') as pending_callbacks
          from receptionist_calls`)
        return response(stats)
      }
      if (path === '/settings' && request.method === 'GET') {
        const rows = await sql.query('select settings,revision from receptionist_settings where singleton=true')
        return response(rows[0] ? { ...rows[0].settings, revision: rows[0].revision } : defaultReceptionistSettings)
      }
      if (path === '/settings' && request.method === 'PUT') {
        const settings = validateReceptionistSettings(JSON.parse(await limitedBody(request, 16384)))
        // Real phone routing is a separate approval gate, never an owner-form side effect.
        if (!settings.testMode && !liveModeAllowed(env)) throw new ReceptionistError('Live activation requires a separately reviewed release', 409)
        const rows = await sql.query(`with changed as (
          update receptionist_settings set settings=$1::jsonb,revision=revision+1,updated_at=now()
          where singleton=true and revision=$2 returning revision,settings
        ), audit as (insert into receptionist_audit(action,actor_id) select 'settings_updated',$3 from changed)
        select * from changed`, [JSON.stringify(settings), settings.revision, actor])
        if (!rows.length) throw new ReceptionistError('Settings changed; reload before saving', 409)
        return response({ ...rows[0].settings, revision: rows[0].revision })
      }
      if (path === '/calls' && request.method === 'GET') {
        return response(await sql.query(`select c.id,c.provider,c.started_at,c.ended_at,c.outcome,c.summary,c.job_id,c.cost_cents,c.latency_ms,
          right(c.caller_phone,4) as phone_last_four,b.customer,b.reason,b.status as callback_status,n.status as notification_status
          from receptionist_calls c left join receptionist_callbacks b on b.call_id=c.id
          left join receptionist_notifications n on n.call_id=c.id and n.kind='owner_push'
          order by c.started_at desc limit 100`))
      }
      const callback = /^\/callbacks\/([^/]+)$/.exec(path)
      if (callback && request.method === 'PATCH') {
        const input = object(JSON.parse(await limitedBody(request, 1024)))
        exactKeys(input, ['status'])
        if (input.status !== 'resolved') throw new ReceptionistError('Invalid status')
        const rows = await sql.query(`with changed as (update receptionist_callbacks set status='resolved' where call_id=$1 returning call_id),
          audit as (insert into receptionist_audit(action,actor_id) select 'callback_resolved',$2 from changed)
          select * from changed`, [decodeURIComponent(callback[1]), actor])
        return response({ resolved: rows.length === 1 })
      }
      if (callback && request.method === 'GET') {
        const rows = await sql.query('select customer,phone,reason,status from receptionist_callbacks where call_id=$1', [decodeURIComponent(callback[1])])
        if (!rows.length) throw new ReceptionistError('Callback not found', 404)
        return response(rows[0])
      }
      throw new ReceptionistError('Not found', 404)
    }
    if (env.AI_RECEPTIONIST_ENABLED !== 'true' || !env.RETELL_WEBHOOK_API_KEY || !env.RETELL_AGENT_ID || !env.RETELL_TEST_PHONE) throw new ReceptionistError('Receptionist unavailable', 503)
    if (request.method !== 'POST' || !/^\/providers\/retell\/(webhook|tools\/[a-zA-Z]+)$/.test(path)) throw new ReceptionistError('Not found', 404)
    const raw = await limitedBody(request)
    stage = 'signature'
    if (!await verifyRetell(raw, request.headers.get('x-retell-signature') || '', env.RETELL_WEBHOOK_API_KEY)) throw new ReceptionistError('Invalid signature', 401)
    stage = 'call_identity'
    const payload = object(JSON.parse(raw))
    const call = retellCall(payload.call, env.RETELL_AGENT_ID, env.RETELL_TEST_PHONE)
    stage = 'database_settings'
    const [stored] = await sql.query('select settings,revision from receptionist_settings where singleton=true')
    if (!stored) throw new ReceptionistError('Receptionist unavailable', 503)
    stage = 'settings_validation'
    const settings = validateReceptionistSettings({ ...stored.settings, revision: stored.revision })
    if (!settings.enabled || !settingsModeAllowed(env, settings.testMode)) throw new ReceptionistError('Receptionist unavailable', 503)
    const id = `${call.provider}:${call.id}`
    stage = 'call_insert'
    await sql.query(`insert into receptionist_calls(id,provider,provider_call_id,caller_phone)
      values($1,$2,$3,$4) on conflict do nothing`, [id, call.provider, call.id, call.caller])
    if (path.endsWith('/webhook')) {
      stage = 'webhook_event'
      const event = textField(payload, 'event', 50)
      if (!['call_started', 'call_ended', 'call_analyzed', 'transfer_started', 'transfer_bridged', 'transfer_cancelled', 'transfer_ended'].includes(event)) return response({ ignored: true })
      const key = `${id}:${event}`
      const metrics = retellMetrics(payload.call)
      await sql.query(`with fresh as (insert into receptionist_events(event_key,call_id,event_type) values($1,$2,$3)
        on conflict do nothing returning call_id)
        update receptionist_calls set started_at=coalesce($4::timestamptz,started_at),
          ended_at=case when $3 in ('call_ended','call_analyzed') then coalesce($5::timestamptz,ended_at,now()) else ended_at end,
          cost_cents=case when $3='call_analyzed' then coalesce($6::numeric,cost_cents) else coalesce(cost_cents,$6::numeric) end,
          latency_ms=case when $3='call_analyzed' then coalesce($7::numeric,latency_ms) else coalesce(latency_ms,$7::numeric) end,
          outcome=case when $3 in ('call_ended','call_analyzed') and outcome='in_progress' then 'ended' else outcome end
        where id in (select call_id from fresh)`, [key, id, event, metrics.startedAt, metrics.endedAt, metrics.costCents, metrics.latencyMs])
      return response({ received: true })
    }
    if (call.ended) throw new ReceptionistError('Call ended', 409)
    stage = 'tool_activity'
    const [active] = await sql.query(`update receptionist_calls set tool_count=tool_count+1
      where id=$1 and ended_at is null and tool_count<100 and started_at>now()-interval '2 hours' returning id`, [id])
    if (!active) throw new ReceptionistError('Call inactive or tool limit reached', 409)
    const tool = path.split('/').at(-1)!
    if (!(receptionistTools as readonly string[]).includes(tool)) throw new ReceptionistError('Unknown tool', 404)
    const args = object(payload.args)
    stage = 'tool_execution'
    switch (tool) {
      case 'getBusinessPolicies': {
        exactKeys(args, [])
        return response({ serviceZips: settings.serviceZips, appliances: settings.appliances,
          diagnosticFee: settings.diagnosticFee || null, suspectedSealedSystemDiagnostic: settings.suspectedSealedSystemDiagnostic,
          excluded: ['Refrigerant recharge', 'Confirmed sealed-system repair', 'Compressor replacement'],
          bookingAvailable: bookingEnabled(env), callbackAvailable: true, recordingAllowed: false })
      }
      case 'checkServiceArea': {
        exactKeys(args, ['zip'])
        const zip = textField(args, 'zip', 5)
        if (!/^\d{5}$/.test(zip)) throw new ReceptionistError('Invalid ZIP')
        return response({ covered: settings.serviceZips.includes(zip) })
      }
      case 'checkServiceEligibility': return response(serviceEligibility(settings, serviceRequest(args)))
      case 'checkAvailability': {
        exactKeys(args, ['date'])
        const date = calendarDate(textField(args, 'date', 10))
        return response({ date, windows: await deps.availability(date), reserved: false, timezone: 'America/Indiana/Indianapolis' })
      }
      case 'lookupCustomer': {
        exactKeys(args, ['name'])
        const name = textField(args, 'name', 120)
        // Caller ID is not authentication. Return no historical address, job or payment data.
        const phone = phoneNumber(call.caller).slice(1)
        const rows = await sql.query(`select 1 from jobs where
          regexp_replace(phone,'[^0-9]','','g') in ($1, right($1,10)) and lower(trim(customer))=lower($2) limit 1`, [phone, name])
        return response({ existingCustomer: rows.length > 0, collectAndConfirmAddress: true })
      }
      case 'requestCallback': {
        exactKeys(args, ['customer', 'phone', 'reason', 'confirmed'])
        if (args.confirmed !== true) throw new ReceptionistError('Confirm callback details with caller')
        const customer = textField(args, 'customer', 120), phone = phoneNumber(textField(args, 'phone', 30)), reason = textField(args, 'reason', 1200)
        await sql.query(`with saved as (insert into receptionist_callbacks(call_id,customer,phone,reason)
          values($1,$2,$3,$4) on conflict do nothing returning call_id)
          update receptionist_calls set outcome='callback_requested'
          where id in (select call_id from saved) and job_id is null`, [id, customer, phone, reason])
        const [saved] = await sql.query('select customer,phone,reason from receptionist_callbacks where call_id=$1', [id])
        if (!saved || saved.customer !== customer || saved.phone !== phone || saved.reason !== reason) throw new ReceptionistError('Callback already recorded with different details', 409)
        return response({ recorded: true, appointmentConfirmed: false, notificationSent: false })
      }
      case 'saveCallSummary': {
        exactKeys(args, ['summary'])
        await sql.query('update receptionist_calls set summary=$2 where id=$1', [id, textField(args, 'summary', 2000)])
        return response({ saved: true })
      }
      case 'createBooking':
        if (!bookingEnabled(env)) return response({ confirmed: false, reason: 'booking_not_enabled', nextAction: 'requestCallback' }, 409)
        return response(await deps.book(id, bookingInput(args)))
    }
    throw new ReceptionistError('Unknown tool', 404)
  } catch (error) {
    // Fixed stage labels and status only: never log provider payloads or exception messages.
    if (actor === null && env.AI_RECEPTIONIST_DEPLOYMENT === 'preview') {
      console.warn(JSON.stringify({ event: 'receptionist_request_failed', stage,
        status: error instanceof ReceptionistError ? error.status : error instanceof SyntaxError ? 400 : 503 }))
    }
    if (error instanceof ReceptionistError) return response({ error: error.message, confirmed: false }, error.status)
    if (error instanceof SyntaxError) return response({ error: 'Invalid JSON', confirmed: false }, 400)
    // Database/provider errors may contain caller data or credentials; never serialize or log them.
    return response({ error: 'Receptionist temporarily unavailable', confirmed: false }, 503)
  }
}
