import { googleActionsConfig, type GoogleActionsEnv } from './googleActionsConfig'

export type BookingStatement = { text: string; values: unknown[] }
export type BookingReceipt = { requestId: string; sessionId: string; payloadHash: string }

export async function bookingPayloadHash(payload: Record<string, unknown>, photos: unknown[]) {
  // Hash only submitted business data, not device clocks, generated attachment IDs or risk scores.
  const fields = ['customer', 'phone', 'email', 'address', 'appliance', 'issue', 'details', 'job_text',
    'service_date', 'service_window', 'lat', 'lng', 'model_photo_names', 'booking_source', 'google_actions_attribution_id']
  const canonical = fields.map(key => [key, payload[key] ?? null])
  const images = photos.map(photo => {
    const value = photo as Record<string, unknown>
    return [value.filename, value.contentType, value.content]
  })
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([canonical, images])))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

export function bookingReceiptLookup(receipt: BookingReceipt): BookingStatement {
  return { text: `select r.request_id, r.session_id, r.payload_hash, to_jsonb(j) as job
    from booking_requests r left join jobs j on j.id = r.job_id
    where r.request_id = $1::text or r.session_id = $2::text`, values: [receipt.requestId, receipt.sessionId] }
}

// Executed together through neon.transaction at SERIALIZABLE isolation, with bounded retry.
export function bookingPersistenceStatements(receipt: BookingReceipt, job: Record<string, unknown>, env: GoogleActionsEnv, attributionId: unknown): BookingStatement[] {
  const { requestId, sessionId, payloadHash } = receipt
  const identity = [requestId, sessionId, payloadHash]
  const owns = `r.request_id = $1::text and r.session_id = $2::text and r.payload_hash = $3::text`
  const statements: BookingStatement[] = [
    { text: 'select id from booking_sessions where id = $1::text for update', values: [sessionId] },
    { text: `insert into booking_requests (request_id, session_id, payload_hash, job_id)
        select $1::text, $2::text, $3::text, $4::text from booking_sessions
        where id = $2::text and job_id is null and created_at > now() - interval '45 minutes'
          and not exists (select 1 from jobs where left(service_date::text,10) = $5::text
            and service_window = $6::text and coalesce(status,'') not in ('complete','canceled'))
          and not exists (select 1 from availability_blocks where blocked_date = $5::date
            and (all_day = true or service_window = $6::text))
        on conflict do nothing returning request_id`, values: [...identity, job.id, job.service_date, job.service_window] },
    { text: `insert into jobs (id,customer,phone,email,address,appliance,issue,details,job_text,service_date,service_window,
        status,invoice,paid,finance_items,payments,model_photo_attachments,lat,lng,created_by_user_id,booking_source)
        select j.id,j.customer,j.phone,j.email,j.address,j.appliance,j.issue,j.details,j.job_text,j.service_date,j.service_window,
        j.status,j.invoice,j.paid,j.finance_items,j.payments,j.model_photo_attachments,j.lat,j.lng,j.created_by_user_id,j.booking_source
        from jsonb_populate_record(null::jobs, $4::jsonb) j join booking_requests r on r.job_id = j.id
        where ${owns} and not exists (select 1 from jobs existing where existing.id = r.job_id)
        returning id`, values: [...identity, JSON.stringify(job)] },
    { text: `update booking_sessions s set job_id = r.job_id, updated_at = now() from booking_requests r
        where s.id = r.session_id and ${owns} and s.job_id is null`, values: identity },
  ]
  const config = googleActionsConfig(env)
  if (config && typeof attributionId === 'string' && /^[0-9a-f-]{36}$/i.test(attributionId)) {
    statements.push({ text: `with queued as (
        insert into google_actions_conversions (job_id,session_id,attribution_id,environment,deployment,partner_id,merchant_id)
        select r.job_id,r.session_id,a.id,a.environment,a.deployment,a.partner_id,a.merchant_id
        from booking_requests r join google_actions_attributions a on a.id = $4::text
        where ${owns} and a.environment = $5::text and a.deployment = $6::text
          and a.partner_id = $7::text and a.merchant_id = $8::text
          and a.captured_at <= now() and a.expires_at > now() and a.rwg_token is not null
        on conflict do nothing returning job_id
      ) update jobs set booking_source = 'google', booking_source_detail = 'actions_center'
        where id in (select job_id from queued) returning id`,
      values: [...identity, attributionId, config.environment, config.deployment, config.partnerId, config.merchantId] })
  }
  statements.push({ text: `insert into booking_risk_events (id,session_id,job_id,event,risk_score,decision,reasons)
      select $4::text,r.session_id,r.job_id,'appointment_created',0,
        case when j.status = 'new' then 'REVIEW' else 'ACCEPT' end,'[]'::jsonb
      from booking_requests r join jobs j on j.id = r.job_id where ${owns}
        and not exists (select 1 from booking_risk_events e where e.session_id = r.session_id and e.event = 'appointment_created')`,
    values: [...identity, crypto.randomUUID()] })
  statements.push(bookingReceiptLookup(receipt))
  return statements
}
