import { Pool } from '@neondatabase/serverless'
import { serviceAreaDecision, serviceZipDecision, type AreaLocation } from '../../shared/receptionist-area'
import { bookingPayloadHash, bookingPersistenceStatements } from '../bookingPersistence'
import { calendarDate, exactKeys, object, phoneNumber, ReceptionistError, serviceEligibility, serviceRequest, textField, validateReceptionistSettings } from '../../shared/receptionist'

export function bookingInput(value: unknown) {
  const p = object(value)
  exactKeys(p, ['customer', 'phone', 'address', 'zip', 'service', 'date', 'window', 'confirmed'])
  if (p.confirmed !== true) throw new ReceptionistError('Read back and confirm all booking details first')
  const zip = textField(p, 'zip', 5)
  if (!/^\d{5}$/.test(zip)) throw new ReceptionistError('Invalid ZIP')
  const address = textField(p, 'address', 300)
  if (address.length < 10) throw new ReceptionistError('Full street address required')
  return { customer: textField(p, 'customer', 120), phone: phoneNumber(textField(p, 'phone', 30)), address, zip,
    service: serviceRequest(p.service), date: calendarDate(textField(p, 'date', 10)), window: textField(p, 'window', 60) }
}
export type PhoneBooking = ReturnType<typeof bookingInput>
export type VerifiedLocation = AreaLocation
export class AddressReviewRequired extends ReceptionistError {}
type GeocodeResult = { partial_match?: boolean; types?: string[]; address_components?: { short_name: string; types: string[] }[]; geometry?: { location?: VerifiedLocation; location_type?: string } }
export function geocodeLocation(value: { status?: string; results?: GeocodeResult[] }, zip: string): VerifiedLocation {
  const results = value.results
  if (value.status !== 'OK' || !Array.isArray(results) || results.length !== 1) throw new ReceptionistError('Address could not be verified; request callback', 422)
  const result = results[0]
  const component = (type: string) => result.address_components?.find(c => c.types.includes(type))?.short_name
  const location = result.geometry?.location
  if (result.partial_match || !result.types?.some(t => ['street_address', 'premise', 'subpremise'].includes(t)) || component('postal_code') !== zip || component('country') !== 'US'
    || !component('street_number') || !component('route') || !location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)
    || Math.abs(location.lat) > 90 || Math.abs(location.lng) > 180) throw new ReceptionistError('Address needs clarification; request callback', 422)
  return { lat: location.lat, lng: location.lng, city: component('locality') || component('postal_town'), precision: result.geometry?.location_type }
}
export async function verifyBookingAddress(input: Pick<PhoneBooking, 'address' | 'zip'>, key: string) {
  if (!key) throw new ReceptionistError('Address verification unavailable; request callback', 503)
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.search = new URLSearchParams({ address: input.address, components: `country:US|postal_code:${input.zip}`, key }).toString()
  let response: Response
  try { response = await fetch(url, { signal: AbortSignal.timeout(5000) }) }
  catch { throw new ReceptionistError('Address verification unavailable; request callback', 503) }
  if (!response.ok) throw new ReceptionistError('Address verification unavailable; request callback', 503)
  return geocodeLocation(await response.json(), input.zip)
}
export type BookingQuery = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
export type BookingContext = { callId: string; input: PhoneBooking; channel?: 'web' | 'phone'; locate: () => Promise<VerifiedLocation>; newJobId: string; requireLeadTime: (date: string, window: string) => void; expectedTestMode?: boolean; approvedBoundaryHash?: string }

// Caller owns a SERIALIZABLE transaction. Reuse the website's exact overlap and
// idempotency statements so phone and website requests compete for the same slot.
export async function persistPhoneBooking(query: BookingQuery, context: BookingContext) {
  const { callId, input } = context
  const { rows: settingsRows } = await query('select settings,revision from receptionist_settings where singleton=true for update')
  const settingsRow = settingsRows[0]
  if (!settingsRow) throw new ReceptionistError('Receptionist unavailable', 503)
  const settings = validateReceptionistSettings({ ...object(settingsRow.settings), revision: settingsRow.revision })
  if (!settings.enabled || settings.testMode !== (context.expectedTestMode ?? true)) throw new ReceptionistError('Receptionist disabled or mode changed', 503)
  const { rows: calls } = await query('select id,ended_at,job_id from receptionist_calls where id=$1 for update', [callId])
  if (!calls.length) throw new ReceptionistError('Call not found', 409)
  const sessionId = callId
  const job = { id: context.newJobId, customer: input.customer, phone: input.phone, email: null,
    address: `${input.address}, ${input.zip}`, appliance: input.service.appliance, issue: input.service.issue,
    details: '', job_text: '', service_date: input.date, service_window: input.window,
    status: 'scheduled', invoice: 0, paid: false, finance_items: [], payments: [], model_photo_attachments: [],
      lat: null as number | null, lng: null as number | null, created_by_user_id: null, booking_source: context.channel === 'web' ? 'website' : null }
  // Exclude transport and geocoder noise. Include all confirmed business intent.
  const payloadHash = await bookingPayloadHash({ ...job, issue: JSON.stringify(input.service) }, [])
  const { rows: previous } = await query('select payload_hash,job_id from booking_requests where session_id=$1', [sessionId])
  if (previous.length) {
    if (previous[0].payload_hash !== payloadHash) throw new ReceptionistError('A different booking already exists for this call', 409)
    const existing = await query('select id,status from jobs where id=$1', [previous[0].job_id])
    if (!existing.rows.length || existing.rows[0].status === 'canceled') throw new ReceptionistError('Original booking is no longer active; request callback', 409)
    return { confirmed: true, jobId: String(previous[0].job_id), replay: true }
  }
  if (calls[0].ended_at) throw new ReceptionistError('Call ended', 409)
  const zipDecision = serviceZipDecision(settings, input.zip)
  if (!zipDecision.covered && zipDecision.nextAction !== 'collectFullAddress') throw new AddressReviewRequired('ZIP outside configured service area; request callback', 422)
  if (!serviceEligibility(settings, input.service).eligible) throw new ReceptionistError('Service not eligible; request callback', 422)
  context.requireLeadTime(input.date, input.window)
  if (!zipDecision.covered) {
    let location: VerifiedLocation
    try { location = await context.locate() }
    catch { throw new AddressReviewRequired('Address could not be verified; request callback', 422) }
    const area = await serviceAreaDecision(settings, input.zip, location, context.approvedBoundaryHash)
    if (!area.covered) throw new AddressReviewRequired(`Address requires manual approval: ${area.reason}; request callback`, 422)
    job.lat = location.lat; job.lng = location.lng
  }
  await query(`insert into booking_sessions(id,device_hash,ip_hash,source,phone)
    values($1,$1,$1,'ai_phone',$2) on conflict do nothing`, [sessionId, input.phone])
  const receipt = { requestId: sessionId, sessionId, payloadHash }
  const statements = bookingPersistenceStatements(receipt, job, {}, null)
  let last: Record<string, unknown>[] = []
  for (const statement of statements) last = (await query(statement.text, statement.values)).rows
  const saved = last[0]
  if (!saved || saved.payload_hash !== payloadHash || !saved.job) throw new ReceptionistError('Appointment time is no longer available', 409)
  const jobId = String(object(saved.job).id)
  if (context.channel === 'web') {
    await query("update jobs set booking_source_detail='voice_assistant' where id=$1", [jobId])
    await query('update receptionist_calls set caller_phone=$2 where id=$1', [callId, input.phone])
  } else {
    await query("update jobs set booking_source_detail='phone_assistant' where id=$1", [jobId])
  }
  await query("update receptionist_calls set job_id=$2,outcome='booked' where id=$1", [callId, jobId])
  await query(`insert into receptionist_notifications(call_id,job_id,kind) values($1,$2,'owner_push') on conflict do nothing`, [callId, jobId])
  return { confirmed: true, jobId, replay: false }
}

export async function createPhoneBooking(databaseUrl: string, context: BookingContext) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  // Serialization retries must not repeat a successful paid address lookup.
  let location: Promise<VerifiedLocation> | undefined
  const retryContext = { ...context, locate: () => location ??= context.locate() }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await pool.connect()
      try {
        await client.query('begin isolation level serializable')
        await client.query("set local statement_timeout='8000ms'")
        await client.query("set local lock_timeout='3000ms'")
        const result = await persistPhoneBooking((text, values) => client.query(text, values), retryContext)
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback')
        const code = (error as { code?: string }).code
        if (!['40001', '40P01'].includes(code || '') || attempt === 2) throw error
      } finally { client.release() }
    }
    throw new ReceptionistError('Booking unavailable; request callback', 503)
  } finally { await pool.end() }
}
