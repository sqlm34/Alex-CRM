import type { NeonQueryFunction } from '@neondatabase/serverless'

export function callStartedPushMessage(token: string, call: { id: string; caller_phone: string; channel?: string }) {
  const web = call.channel === 'web'
  const title = web ? 'Starting Book by Voice' : 'Phone Emily · Call in progress'
  const body = web
    ? 'A website visitor is speaking with Emily. Appointment not confirmed yet. Open CRM for conversation details.'
    : `${call.caller_phone || 'Unknown caller'}\nEmily is speaking with a customer. Open CRM for call details.`
  const icon = web ? 'ic_stat_site_booking' : 'ic_stat_phone_assistant'
  return { token, notification: { title, body },
    data: { event: 'receptionist_call', call_id: call.id, title, body, notificationIcon: icon, call_phase: 'started' },
    android: { priority: 'HIGH', ttl: '60s', notification: { channel_id: 'alex-new-orders-v5', sound: 'nice_melodic_sound',
      tag: `call-${call.id}`, icon, notification_priority: 'PRIORITY_MAX', visibility: 'PRIVATE' } } }
}

export function callEndedPushMessage(token: string, call: { id: string; caller_phone: string; duration_ms?: number | string | null; job_id?: string | null; channel?: string }) {
  const title = `${call.channel === 'web' ? 'Book by Voice' : 'Phone Emily'} · ${call.job_id ? 'Appointment booked' : 'Call ended'}`
  const icon = call.channel === 'web' ? (call.job_id ? 'ic_stat_site_booking' : 'ic_stat_call_ended') : 'ic_stat_phone_assistant'
  const seconds = call.duration_ms == null ? null : Math.floor(Number(call.duration_ms) / 1000)
  const duration = seconds == null ? '' : ` - ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const body = `${call.caller_phone || 'Unknown caller'}${duration}\nOpen CRM for call details and recording.`
  return { token, notification: { title, body }, data: { event: 'receptionist_call', call_id: call.id, title, body, notificationIcon: icon },
    android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: 'alex-new-orders-v5', sound: 'nice_melodic_sound',
      tag: `call-${call.id}`, icon, notification_priority: 'PRIORITY_MAX', visibility: 'PRIVATE' } } }
}

export async function processReceptionistCallPush(sql: NeonQueryFunction<false, false>, send: (callId: string, phase: 'started' | 'ended') => Promise<void>) {
  await sql.query("update receptionist_events set event_type='call_start_push_unknown' where event_type='call_start_push_sending' and created_at<now()-interval '5 minutes'")
  await sql.query(`update receptionist_events e set event_type='call_start_push_skipped'
    where e.event_type='call_start_push_pending' and (e.created_at<now()-interval '1 minute'
      or exists(select 1 from receptionist_calls c where c.id=e.call_id and c.ended_at is not null))`)
  await sql.query("update receptionist_events set event_type='call_push_unknown' where event_type='call_push_sending' and created_at<now()-interval '5 minutes'")
  for (let i = 0; i < 10; i++) {
    const [item] = await sql.query(`with candidate as (
      select event_key from receptionist_events where event_type in ('call_push_pending','call_start_push_pending')
      order by created_at for update skip locked limit 1
    ) update receptionist_events e set event_type=case when e.event_type='call_start_push_pending' then 'call_start_push_sending' else 'call_push_sending' end,created_at=now()
      from candidate where e.event_key=candidate.event_key returning e.event_key,e.call_id,e.event_type`)
    if (!item) return
    const started = item.event_type === 'call_start_push_sending'
    const prefix = started ? 'call_start_push' : 'call_push'
    let status = `${prefix}_unknown`
    try { await send(item.call_id, started ? 'started' : 'ended'); status = `${prefix}_sent` } catch { /* Do not repeat an ambiguous delivery. */ }
    await sql.query('update receptionist_events set event_type=$2 where event_key=$1', [item.event_key, status])
  }
}

export function callbackPushMessage(token: string, callId: string, callback: { customer: string; phone: string; reason: string; kind?: string }) {
  const icon = callback.kind === 'abandoned' ? 'ic_stat_call_ended' : 'ic_stat_phone_assistant'
  const title = callback.kind === 'abandoned' ? 'CALL ENDED WITHOUT A BOOKING' : 'CLIENT WAITING FOR A CALLBACK'
  const body = `${callback.customer}\n${callback.phone}\n${callback.reason.slice(0, 240)}\nOpen CRM to call back. Appointment not confirmed.`
  return { token, notification: { title, body },
    data: { event: 'receptionist_callback', call_id: callId, title, body, notificationIcon: icon },
    android: { priority: 'HIGH', ttl: '3600s', notification: {
      channel_id: 'alex-new-orders-v5', sound: 'nice_melodic_sound', tag: `callback-${callId}`,
      icon, notification_priority: 'PRIORITY_MAX', visibility: 'PRIVATE',
    } },
  }
}

export async function processReceptionistCallbackPush(sql: NeonQueryFunction<false, false>, send: (callId: string) => Promise<void>) {
  // Allow in-flight booking/callback tools to settle before creating a follow-up.
  await sql.query(`insert into receptionist_callbacks(call_id,customer,phone,reason,kind)
    select c.id,'Caller',c.caller_phone,
      'Caller disconnected without a booking. Duration: ' || coalesce(ceil(c.duration_ms/1000.0)::text || ' seconds','not reported') || '. Reason for hanging up is unknown.',
      'abandoned'
    from receptionist_calls c where c.job_id is null and c.outcome='ended'
      and c.disconnect_reason='user_hangup' and c.ended_at<now()-interval '1 minute'
      and not exists (select 1 from receptionist_callbacks b where b.call_id=c.id)
    on conflict do nothing`)
  await sql.query("update receptionist_callbacks set push_status='unknown',push_updated_at=now() where push_status='sending' and push_updated_at<now()-interval '5 minutes'")
  for (let i = 0; i < 10; i++) {
    const [item] = await sql.query(`with candidate as (
      select call_id from receptionist_callbacks where status='pending' and push_status='pending'
      order by created_at for update skip locked limit 1
    ) update receptionist_callbacks c set push_status='sending',push_updated_at=now()
      from candidate where c.call_id=candidate.call_id returning c.call_id`)
    if (!item) return
    try {
      await send(item.call_id)
      await sql.query("update receptionist_callbacks set push_status='sent',push_updated_at=now() where call_id=$1", [item.call_id])
    } catch {
      // A failed response may still mean delivery; never ring twice blindly.
      await sql.query("update receptionist_callbacks set push_status='unknown',push_updated_at=now() where call_id=$1", [item.call_id])
    }
  }
}

export async function checkReceptionistPush(sql: NeonQueryFunction<false, false>, actor: string, send: () => Promise<void>) {
  const id = 'initial-production-v1'
  const claimed = await sql.query(`insert into receptionist_push_checks(id,actor_id,status)
    values($1,$2,'sending') on conflict do nothing returning id`, [id, actor])
  if (!claimed.length) {
    const [existing] = await sql.query('select status from receptionist_push_checks where id=$1', [id])
    return { status: existing?.status || 'unknown', replay: true }
  }
  let status = 'unknown'
  try { await send(); status = 'accepted' } catch { /* Never retry an ambiguous delivery. */ }
  await sql.query('update receptionist_push_checks set status=$2 where id=$1', [id, status])
  return { status, replay: false }
}

// FCM has no application idempotency receipt. Never blindly resend an ambiguous
// delivery: retain it as unknown for owner review instead of ringing twice.
export async function processReceptionistPush(sql: NeonQueryFunction<false, false>, send: (jobId: string) => Promise<void>) {
  await sql.query("update receptionist_notifications set status='unknown',updated_at=now() where status='sending' and updated_at<now()-interval '5 minutes'")
  for (let i = 0; i < 10; i++) {
    const [item] = await sql.query(`with candidate as (
      select id from receptionist_notifications where status='pending' order by id for update skip locked limit 1
    ) update receptionist_notifications n set status='sending',updated_at=now()
      from candidate where n.id=candidate.id returning n.id,n.job_id`)
    if (!item) return
    try {
      await send(item.job_id)
      await sql.query("update receptionist_notifications set status='sent',updated_at=now() where id=$1", [item.id])
    } catch {
      await sql.query("update receptionist_notifications set status='unknown',updated_at=now() where id=$1", [item.id])
    }
  }
}
