import { Pool } from '@neondatabase/serverless'
import { bookingArrivalMessage, bookingTimeZone, bookingTimes, googleBookingCalendarUrl, type CalendarBooking } from '../shared/bookingCalendar'
import { ensureBookingNotificationTables } from './bookingNotificationSchema'

export type BookingNotificationEnv = {
  DATABASE_URL: string; CUSTOMER_BOOKING_EMAIL_ENABLED?: string; RESEND_API_KEY?: string; INVOICE_FROM_EMAIL?: string;
  BOOKING_CALENDAR_ID?: string; BOOKING_CALENDAR_CLIENT_ID?: string; BOOKING_CALENDAR_CLIENT_SECRET?: string; BOOKING_CALENDAR_REFRESH_TOKEN?: string;
}
type QueryClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }> }
type Notification = { id: string; job_id: string; revision: number; kind: string; payload: CalendarBooking; created_at: string; first_attempt_at?: string }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const calendarConnected = (env: BookingNotificationEnv) => Boolean(env.BOOKING_CALENDAR_ID && env.BOOKING_CALENDAR_CLIENT_ID && env.BOOKING_CALENDAR_CLIENT_SECRET && env.BOOKING_CALENDAR_REFRESH_TOKEN)

export function customerBookingEmail(job: CalendarBooking, kind: string, from: string, managedCalendar = false) {
  const canceled = kind === 'cancellation'
  const pending = job.status === 'new'
  const subject = canceled ? 'Your Alex Appliance Repair appointment has been canceled' : kind === 'reminder'
    ? 'Reminder: your Alex Appliance Repair appointment' : pending ? 'We received your Alex Appliance Repair booking request'
    : kind === 'update' ? 'Your Alex Appliance Repair appointment has been updated' : 'Your Alex Appliance Repair appointment is confirmed'
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${job.service_date.slice(0,10)}T12:00:00Z`))
  const intro = canceled ? 'Your appointment has been canceled. No further visit reminders will be sent for this booking.'
    : kind === 'reminder' ? 'A friendly reminder about your upcoming service visit.'
    : pending ? 'Thank you for choosing Alex Appliance Repair! We received your request and will contact you to confirm your appointment.'
    : kind === 'update' ? 'Your service appointment details have been updated. Please review the schedule below.'
    : 'Thank you for choosing Alex Appliance Repair! We appreciate your trust and look forward to helping you. Your appointment is confirmed.'
  const body = [`Hello ${job.customer || 'there'},`, intro, `${date}\nArrival window: ${job.service_window} (Indianapolis time)\nService: ${job.appliance}\nAddress: ${job.address}`,
    ...(!canceled ? [bookingArrivalMessage] : []),
    'Questions or changes? Call (463) 248-8429 or reply to this email.', 'Alex Appliance Repair']
  if (managedCalendar && !canceled && !pending) body.push('We will also send a calendar invitation. Accept that invitation to receive appointment updates and cancellations in your calendar. Calendar alerts depend on your settings.')
  const calendar = !managedCalendar && !canceled && !pending ? googleBookingCalendarUrl(job) : null
  const note = 'A manually saved calendar copy does not update automatically. If your appointment changes or is canceled, update or remove that copy. Calendar alerts depend on your settings.'
  return { from, to: [job.email!], reply_to: 'alexeasyrepair@gmail.com', subject,
    text: body.join('\n\n') + (calendar ? `\n\nSave to Google Calendar: ${calendar}\n${note}` : ''),
    html: body.map(p => `<p>${escapeHtml(p).replace(/\n/g,'<br>')}</p>`).join('') + (calendar ? `<p><a href="${escapeHtml(calendar)}">Save to Google Calendar</a></p><p>${note}</p>` : '') }
}

export async function syncBookingCalendar(env: BookingNotificationEnv, job: CalendarBooking, request: typeof fetch = fetch) {
  if (!calendarConnected(env)) throw Error('Calendar connection required')
  const tokenResponse = await request('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ client_id: env.BOOKING_CALENDAR_CLIENT_ID!, client_secret: env.BOOKING_CALENDAR_CLIENT_SECRET!, refresh_token: env.BOOKING_CALENDAR_REFRESH_TOKEN!, grant_type: 'refresh_token' }) })
  if (!tokenResponse.ok) throw Error(`Calendar authorization ${tokenResponse.status}`)
  const token = await tokenResponse.json() as { access_token: string }
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(job.id))), b => b.toString(16).padStart(2,'0')).join('')
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.BOOKING_CALENDAR_ID!)}/events`
  const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }
  if (job.status === 'canceled') {
    const result = await request(`${base}/${id}?sendUpdates=all`, { method: 'DELETE', headers, signal: AbortSignal.timeout(10000) })
    if (!result.ok && ![404,410].includes(result.status)) throw Error(`Calendar cancellation ${result.status}`)
    return id
  }
  const times = bookingTimes(job)
  const body = { summary: `Alex Appliance Repair - ${job.appliance}`, location: job.address, description: `${bookingArrivalMessage}\nCall (463) 248-8429 for changes.`,
    start: { dateTime: times.start, timeZone: bookingTimeZone }, end: { dateTime: times.end, timeZone: bookingTimeZone },
    attendees: [{ email: job.email }], status: 'confirmed', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1440 }] } }
  const existing = await request(`${base}/${id}`, { headers, signal: AbortSignal.timeout(10000) })
  if (!existing.ok && ![404,410].includes(existing.status)) throw Error(`Calendar lookup ${existing.status}`)
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))), b => b.toString(16).padStart(2,'0')).join('')
  if (existing.ok) {
    const saved = await existing.json() as { status?: string; extendedProperties?: { private?: { bookingFingerprint?: string } } }
    if (saved.status !== 'cancelled' && saved.extendedProperties?.private?.bookingFingerprint === fingerprint) return id
  }
  const event = { ...body, extendedProperties: { private: { bookingFingerprint: fingerprint } } }
  const result = await request(existing.ok ? `${base}/${id}?sendUpdates=all` : `${base}?sendUpdates=all`, {
    method: existing.ok ? 'PUT' : 'POST', headers, body: JSON.stringify(existing.ok ? event : { ...event, id }), signal: AbortSignal.timeout(10000) })
  if (!result.ok) throw Error(`Calendar sync ${result.status}`)
  return id
}

export async function deliverBookingNotification(client: QueryClient, env: BookingNotificationEnv, id: string, request: typeof fetch = fetch) {
  // Lock jobs before subscriptions, matching the UPDATE/DELETE trigger order. A cancel
  // cannot commit while an in-flight dispatch still holds this transaction's lock.
  const found = await client.query('select job_id from booking_notification_outbox where id=$1', [id])
  if (!found.rows.length) return false
  const jobId = found.rows[0].job_id
  await client.query('select id from jobs where id=$1 for update', [jobId])
  await client.query('select job_id from booking_notification_subscriptions where job_id=$1 for update', [jobId])
  const result = await client.query(`select o.* from booking_notification_outbox o join booking_notification_subscriptions s on s.job_id=o.job_id
    where o.id=$1 and o.revision=s.revision and o.sent_at is null and o.suppressed_at is null
    and o.due_at<=now() and o.next_attempt_at<=now() and o.attempts<8 for update of o`, [id])
  if (!result.rows.length) return false
  const row = result.rows[0] as Notification
  if (row.kind === 'calendar' && !calendarConnected(env)) return false
  const active = await client.query('select status,service_date,service_window from jobs where id=$1', [jobId])
  const live = active.rows[0]
  const cancellation = row.kind === 'cancellation' || (row.kind === 'calendar' && row.payload.status === 'canceled')
  if ((!cancellation && (!live || ['canceled','complete'].includes(live.status))) || (cancellation && live && live.status !== 'canceled')) {
    await client.query('update booking_notification_outbox set suppressed_at=now() where id=$1', [id]); return false
  }
  if (row.kind === 'reminder') {
    const timely = await client.query(`select ((service_date::date + split_part(split_part(service_window,'; ',1),' - ',1)::time)
      at time zone 'America/Indiana/Indianapolis') > now() as future from jobs where id=$1 and status='scheduled'`, [jobId])
    if (!timely.rows[0]?.future) { await client.query('update booking_notification_outbox set suppressed_at=now() where id=$1',[id]); return false }
  }
  // Resend retains idempotency keys for 24h. Ambiguous sends are not retried outside
  // that window; the persisted first attempt is written before entering this transaction.
  if (row.first_attempt_at && Date.now() - new Date(row.first_attempt_at).getTime() >= 23 * 3600000) {
    await client.query("update booking_notification_outbox set attempts=8,last_error='Retry window expired; manual review required' where id=$1",[id]); return false
  }
  try {
    let providerId: string
    if (row.kind === 'calendar') providerId = await syncBookingCalendar(env, row.payload, request)
    else {
      const response = await request('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `booking-notification/${row.id}` },
        body: JSON.stringify(customerBookingEmail(row.payload, row.kind, env.INVOICE_FROM_EMAIL!, calendarConnected(env))) })
      if (!response.ok) throw Error(`Email provider ${response.status}`)
      const sent = await response.json() as { id?: string }
      if (!sent.id) throw Error('Email provider returned no message ID')
      providerId = sent.id
    }
    await client.query('update booking_notification_outbox set sent_at=now(),provider_id=$2,attempts=attempts+1,last_error=null where id=$1', [id,providerId])
    return true
  } catch (error) {
    await client.query(`update booking_notification_outbox set attempts=attempts+1,next_attempt_at=now()+interval '10 minutes',last_error=$2 where id=$1`,
      [id,error instanceof Error ? error.message.slice(0,160) : 'Dispatch failed'])
    return false
  }
}

export async function processBookingNotifications(env: BookingNotificationEnv) {
  if (env.CUSTOMER_BOOKING_EMAIL_ENABLED !== 'true' || !env.RESEND_API_KEY || !env.INVOICE_FROM_EMAIL) return
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 })
  try {
    await ensureBookingNotificationTables({ query: async (text, values) => pool.query(text, values) })
    const due = await pool.query(`select id from booking_notification_outbox where sent_at is null and suppressed_at is null
      and due_at<=now() and next_attempt_at<=now() and attempts<8 and (kind<>'calendar' or $1::boolean)
      order by due_at,id limit 20`, [calendarConnected(env)])
    for (const row of due.rows) {
      // Persist the attempt timestamp independently so a worker termination after
      // provider acceptance still has a bounded, stable idempotent retry window.
      await pool.query('update booking_notification_outbox set first_attempt_at=coalesce(first_attempt_at,now()) where id=$1',[row.id])
      const client = await pool.connect()
      try { await client.query('begin'); await deliverBookingNotification(client, env, row.id); await client.query('commit') }
      catch (error) { await client.query('rollback'); console.error('Booking notification transaction failed', error instanceof Error ? error.name : 'error') }
      finally { client.release() }
    }
  } finally { await pool.end() }
}
