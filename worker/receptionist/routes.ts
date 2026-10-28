import type { NeonQueryFunction } from '@neondatabase/serverless'
import { closingContext } from './conversation'
import { inboundPhoneBlock, phoneBlockManagement } from './phone-blocks'
import { validCallDate } from '../../shared/receptionist-calendar'
import { deleteConversation } from './delete-conversation'
import { calendarDate, defaultReceptionistSettings, exactKeys, object, phoneNumber, receptionistTools, ReceptionistError, serviceEligibility, serviceRequest, textField, validateReceptionistSettings } from '../../shared/receptionist'
import { limitedBody, retellCall, retellMetrics, verifyRetell } from './retell'
import { AddressReviewRequired, bookingInput, verifyBookingAddress, type PhoneBooking } from './booking'
import { serviceAreaDecision, serviceZipDecision } from '../../shared/receptionist-area'
import { liveModeAllowed, settingsModeAllowed } from './mode'
import { callLocation, statedLocation, summarizeCallLocations } from '../../shared/receptionist-location'
import { authorizedWebCall, startWebCall, webBookingResult, webDraftInput, type WebCallEnv } from './web'

export type ReceptionistEnv = WebCallEnv & {
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
  AI_RECEPTIONIST_RECORDING_PLAYBACK_ENABLED?: string
  AI_RECEPTIONIST_APPROVED_BOUNDARY_SHA256?: string
}
type Dependencies = {
  sql: NeonQueryFunction<false, false>
  owner: () => Promise<string>
  availability: (date: string) => Promise<string[]>
  book: (callId: string, input: PhoneBooking, channel?: 'web' | 'phone') => Promise<unknown>
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
  const actor = path.startsWith('/providers/') || path === '/web/start' || path === '/web/result' ? null : await deps.owner()
  let stage = 'configuration'
  try {
    if (path === '/providers/retell/inbound') return response(await inboundPhoneBlock(request, env, sql))
    if (path === '/blocked-numbers') return response(await phoneBlockManagement(request, sql, actor || ''))
    if (path === '/web/start') return response(await startWebCall(request, env, sql))
    if (path === '/web/result') return response(await webBookingResult(request, env, sql))
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
      if (path === '/location-stats' && request.method === 'GET') {
        const month = new URL(request.url).searchParams.get('month') || ''
        if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new ReceptionistError('Invalid month')
        const rows = await sql.query(`select c.location_city,c.location_zip,c.summary,b.reason,j.address as job_address
          from receptionist_calls c left join receptionist_callbacks b on b.call_id=c.id
          left join jobs j on j.id=c.job_id
          where c.started_at >= ($1::date::timestamp at time zone 'America/Indiana/Indianapolis')
          and c.started_at < (($1::date + interval '1 month')::timestamp at time zone 'America/Indiana/Indianapolis')`, [`${month}-01`])
        return response({ month, ...summarizeCallLocations(rows.map(callLocation)) })
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
        const settings = validateReceptionistSettings(JSON.parse(await limitedBody(request, 65536)))
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
      if ((path === '/calls' || path === '/abandoned') && request.method === 'GET') {
        const date = new URL(request.url).searchParams.get('date')
        const timeline = new URL(request.url).searchParams.get('timeline') === 'true'
        if (date !== null && !validCallDate(date)) throw new ReceptionistError('Invalid call date')
        const rows = await sql.query(`select c.id,c.provider,c.started_at,c.ended_at,c.outcome,c.summary,c.job_id,c.cost_cents,c.latency_ms,
          case when exists(select 1 from receptionist_web_sessions w where w.provider_call_id=c.provider_call_id) then 'web' else 'phone' end as channel,
          c.location_city,c.location_zip,j.address as job_address,
          c.caller_phone,c.duration_ms,c.disconnect_reason,b.kind as callback_kind,
          right(c.caller_phone,4) as phone_last_four,coalesce(nullif(j.customer,''),b.customer) as customer,b.reason,b.status as callback_status,n.status as notification_status
          from receptionist_calls c left join receptionist_callbacks b on b.call_id=c.id
          left join jobs j on j.id=c.job_id
          left join receptionist_notifications n on n.call_id=c.id and n.kind='owner_push'
          where ($1::boolean=false or b.kind='abandoned')
          and ($2::date is null or (c.started_at >= ($2::date::timestamp at time zone 'America/Indiana/Indianapolis')
            and c.started_at < (($2::date + 1)::timestamp at time zone 'America/Indiana/Indianapolis')))
          order by c.started_at desc limit case when $2::date is null and not $3::boolean then 100 else null end`, [path === '/abandoned', date, timeline])
        return response(rows.map(row => ({ ...row, location: callLocation(row) })))
      }
      const detail = /^\/calls\/([^/]+)$/.exec(path)
      if (detail && request.method === 'DELETE') {
        if (!actor) throw new ReceptionistError('Unauthorized', 401)
        const input = object(JSON.parse(await limitedBody(request, 1024)))
        exactKeys(input, ['confirmed'])
        if (input.confirmed !== true) throw new ReceptionistError('Confirm conversation deletion')
        return response(await deleteConversation(sql, decodeURIComponent(detail[1]), actor, env))
      }
      if (detail && request.method === 'GET') {
        const [saved] = await sql.query(`select c.*,coalesce(nullif(j.customer,''),b.customer) as customer,b.reason,b.status as callback_status,b.kind as callback_kind,j.address as job_address,
          case when exists(select 1 from receptionist_web_sessions w where w.provider_call_id=c.provider_call_id) then 'web' else 'phone' end as channel
          from receptionist_calls c left join receptionist_callbacks b on b.call_id=c.id
          left join jobs j on j.id=c.job_id where c.id=$1`, [decodeURIComponent(detail[1])])
        if (!saved) return response({ error: 'Call not found' }, 404)
        return response({ ...saved, location: callLocation(saved) })
      }
      const recording = /^\/calls\/([^/]+)\/recording$/.exec(path)
      if (recording && request.method === 'GET') {
        if (env.AI_RECEPTIONIST_RECORDING_PLAYBACK_ENABLED !== 'true') return response({ available: false, reason: 'Recording playback is not enabled.' })
        const [saved] = await sql.query('select provider_call_id from receptionist_calls where id=$1', [decodeURIComponent(recording[1])])
        // The active Retell account key also signs webhooks. The older management
        // key may no longer have access to this account's calls.
        const recordingKey = env.RETELL_WEBHOOK_API_KEY || env.RETELL_API_KEY
        if (!saved || !recordingKey) return response({ available: false, reason: 'Recording unavailable.' })
        const result = await fetch(`https://api.retellai.com/v2/get-call/${encodeURIComponent(saved.provider_call_id)}`, {
          headers: { Authorization: `Bearer ${recordingKey}` }, signal: AbortSignal.timeout(8000), redirect: 'manual',
        })
        if (!result.ok) return response({ available: false, reason: 'Recording unavailable. Try again later.' })
        const data = await result.json() as { recording_url?: string }
        if (!data.recording_url) return response({ available: false, reason: 'No saved recording is available.' })
        const url = new URL(data.recording_url)
        if (url.protocol !== 'https:' || url.username || url.password) return response({ available: false, reason: 'Recording unavailable.' })
        return response({ available: true, url: url.href })
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
        const rows = await sql.query('select customer,phone,reason,status,kind from receptionist_callbacks where call_id=$1', [decodeURIComponent(callback[1])])
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
    const isWeb = object(payload.call).call_type === 'web_call'
    const call = isWeb ? await authorizedWebCall(payload.call, env, sql)
      : retellCall(payload.call, env.RETELL_AGENT_ID, env.RETELL_TEST_PHONE)
    stage = 'database_settings'
    const [stored] = await sql.query('select settings,revision from receptionist_settings where singleton=true')
    if (!stored) throw new ReceptionistError('Receptionist unavailable', 503)
    stage = 'settings_validation'
    const settings = validateReceptionistSettings({ ...stored.settings, revision: stored.revision })
    if (!settings.enabled || !settingsModeAllowed(env, settings.testMode)) throw new ReceptionistError('Receptionist unavailable', 503)
    const id = `${call.provider}:${call.id}`
    const [deleted] = await sql.query('select call_id from receptionist_deleted_calls where call_id=$1', [id])
    if (deleted) return response({ ignored: true })
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
          duration_ms=coalesce($8::bigint,duration_ms),
          disconnect_reason=coalesce($9::text,disconnect_reason),
          outcome=case when $3 in ('call_ended','call_analyzed') and outcome='in_progress' then 'ended' else outcome end
        where id in (select call_id from fresh)`, [key, id, event, metrics.startedAt, metrics.endedAt, metrics.costCents, metrics.latencyMs, metrics.durationMs, metrics.disconnectReason])
      if (event === 'call_started' && !call.ended) {
        await sql.query(`insert into receptionist_events(event_key,call_id,event_type)
          select $1,$2,'call_start_push_pending' from receptionist_calls
          where id=$2 and ended_at is null and started_at>now()-interval '1 minute'
          on conflict do nothing`, [`${id}:owner_call_start_push`, id])
      }
      if (event === 'call_ended' || event === 'call_analyzed') {
        if (isWeb) {
          await sql.query(`with ended as (update receptionist_web_sessions set ended_at=coalesce(ended_at,now())
            where provider_call_id=$1 returning id)
            update receptionist_web_capacity set lease_until=now() where session_id in (select id from ended)`, [call.id])
        }
        await sql.query(`insert into receptionist_events(event_key,call_id,event_type)
          values($1,$2,'call_push_pending') on conflict do nothing`, [`${id}:owner_call_push`, id])
      }
      return response({ received: true })
    }
    if (call.ended) throw new ReceptionistError('Call ended', 409)
    if (isWeb) {
      if (env.RECEPTIONIST_WEB_ENABLED !== 'true') throw new ReceptionistError('Web booking disabled', 503)
      const [activeWeb] = await sql.query(`select id from receptionist_web_sessions
        where provider_call_id=$1 and ended_at is null and expires_at>now()`, [call.id])
      if (!activeWeb) throw new ReceptionistError('Web session expired', 409)
    }
    stage = 'tool_activity'
    const [active] = await sql.query(`update receptionist_calls set tool_count=tool_count+1
      where id=$1 and ended_at is null and tool_count<100 and started_at>now()-interval '2 hours' returning id`, [id])
    if (!active) throw new ReceptionistError('Call inactive or tool limit reached', 409)
    const tool = path.split('/').at(-1)!
    if (!(receptionistTools as readonly string[]).includes(tool) && !(isWeb && tool === 'updateBookingDraft')) throw new ReceptionistError('Unknown tool', 404)
    const args = object(payload.args)
    stage = 'tool_execution'
    switch (tool) {
      case 'updateBookingDraft': {
        const draft = webDraftInput(args)
        await sql.query('update receptionist_web_sessions set draft=draft || $2::jsonb where provider_call_id=$1', [call.id, JSON.stringify(draft)])
        return response({ saved: true, appointmentConfirmed: false })
      }
      case 'getBusinessPolicies': {
        exactKeys(args, [])
        return response({ closingContext: closingContext(), serviceZips: settings.serviceZips, appliances: settings.appliances.includes('Oven repair') ? [...settings.appliances, 'Built-in microwave oven combination'] : settings.appliances,
          northIndianapolis: settings.northIndianapolis || null, zipCoverage: settings.zipCoverage || {}, zipOnlyZips: settings.zipOnlyZips || [], fullAddressVerificationRequired: !settings.zipOnlyZips?.length,
          indianapolisPolicy: settings.zipOnlyZips?.length ? 'For ZIPs in zipOnlyZips, the owner approves coverage without geocoding or geographic boundary checks. checkServiceArea confirms coverage from ZIP alone. Still collect the complete visit address, verify service eligibility and availability, and read back all details before createBooking. Other ZIPs follow their existing rules.' : 'We service the represented North Indianapolis neighborhoods, not entire ZIP boundaries. Ask ZIP first, then verify the full street address with checkServiceArea. Primary and candidate ZIPs both need geographic verification. Follow nextAction; confirm a callback for manual review when necessary. Do not ask again for unchanged details already verified during this call.',
          diagnosticFee: settings.diagnosticFee || null, suspectedSealedSystemDiagnostic: settings.suspectedSealedSystemDiagnostic,
          excluded: ['Refrigerant recharge', 'Confirmed sealed-system repair', 'Compressor replacement', 'Filter-drier replacement', 'Condenser coil replacement', 'Evaporator coil replacement', 'Sealed-system brazing or welding', 'Over-the-range and countertop microwave repair'],
          microwavePolicy: { supported: settings.appliances.includes('Oven repair') ? 'Built-in microwave and wall oven combination only' : null, applianceValue: 'Built-in microwave oven combination', clarifyInstallation: true, overTheRangeRepairStartingCost: 250, currency: 'USD', explanation: 'We do not service over-the-range microwaves. Repair work would start at $250, so replacement may be more economical. This is not an offer to repair an excluded appliance. Do not quote a current retail replacement price.' },
          bookingAvailable: bookingEnabled(env), callbackAvailable: true, recordingAllowed: false })
      }
      case 'checkServiceArea': {
        exactKeys(args, ['zip', 'address'])
        const zip = typeof args.zip === 'string' ? args.zip.trim() : ''
        if (/^\d{5}$/.test(zip)) {
          const location = statedLocation(typeof args.address === 'string' ? args.address : '')
          await sql.query(`update receptionist_calls set location_city=case when location_zip=$2 then coalesce($3,location_city) else $3 end,location_zip=$2 where id=$1`, [id, zip, location.city])
        }
        const zipDecision = serviceZipDecision(settings, zip)
        if (zipDecision.nextAction !== 'collectFullAddress') return response({ ...zipDecision, postalLocation: postalLocation(zip), addressCollection: 'Ask only for house number, street and unit if applicable. Use postalLocation for city/state unless the caller supplied a different city. Do not routinely ask city or state.' })
        const address = textField(args, 'address', 300, true)
        if (address.length < 10) return response({ covered: false, nextAction: 'collectFullAddress', reason: 'full_street_address_required', postalLocation: postalLocation(zip) })
        try {
          const location = await verifyBookingAddress({ address, zip }, env.AI_RECEPTIONIST_GEOCODING_KEY || '')
          return response({ ...await serviceAreaDecision(settings, zip, location, env.AI_RECEPTIONIST_APPROVED_BOUNDARY_SHA256), postalLocation: postalLocation(zip) })
        } catch {
          return response({ covered: false, reason: 'address_could_not_be_verified', nextAction: 'requestCallback' })
        }
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
        if (isWeb) return response({ existingCustomer: false, collectAndConfirmAddress: true, collectAndConfirmPhone: true })
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
        if (isWeb) await sql.query('update receptionist_calls set caller_phone=$2 where id=$1', [id, phone])
        return response({ recorded: true, appointmentConfirmed: false, notificationSent: false })
      }
      case 'saveCallSummary': {
        exactKeys(args, ['summary'])
        await sql.query('update receptionist_calls set summary=$2 where id=$1', [id, textField(args, 'summary', 2000)])
        return response({ saved: true })
      }
      case 'createBooking': {
        if (!bookingEnabled(env)) return response({ confirmed: false, reason: 'booking_not_enabled', nextAction: 'requestCallback' }, 409)
        const input = bookingInput(args)
        const location = statedLocation(input.address)
        await sql.query('update receptionist_calls set location_zip=$2,location_city=$3 where id=$1', [id, input.zip, location.city])
        try { return response(await deps.book(id, input, isWeb ? 'web' : 'phone')) }
        catch (error) {
          if (isWeb && error instanceof ReceptionistError && error.status === 409 && error.message === 'Appointment time is no longer available') {
            return response({ confirmed: false, reason: 'slot_taken', date: input.date,
              windows: await deps.availability(input.date), reserved: false,
              nextAction: 'offerNewWindowsAndConfirmAgain' })
          }
          if (!(error instanceof AddressReviewRequired)) throw error
          // Booking details were confirmed, but no appointment was created. Retain
          // one manual-review request outside the rolled-back booking transaction.
          await sql.query(`with saved as (insert into receptionist_callbacks(call_id,customer,phone,reason)
            values($1,$2,$3,$4) on conflict do nothing returning call_id)
            update receptionist_calls set outcome='callback_requested'
            where id in (select call_id from saved) and job_id is null`,
          [id, input.customer, input.phone, `Service-area review: ${input.address}, ${input.zip}. ${error.message}`])
          return response({ confirmed: false, callbackRecorded: true, reason: 'address_requires_manual_approval', nextAction: 'explainManualReview' })
        }
      }
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
import { postalLocation } from '../../shared/receptionist-postal'
