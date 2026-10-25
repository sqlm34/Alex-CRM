import { calendarDate, serviceEligibility, validateReceptionistSettings, type ReceptionistSettings } from '../../shared/receptionist'
import { serviceAreaDecision, serviceZipDecision } from '../../shared/receptionist-area'
import { bookingPersistenceStatements } from '../bookingPersistence'
import type { GoogleActionsEnv } from '../googleActionsConfig'
import { bookingInput, cancelInput, slotsInput, type ApprovalInput } from './schemas'
import { digest, McpError, type Principal } from './security'
import type { McpBackend } from './server'

export type Query = (text: string, values?: unknown[]) => Promise<Record<string, any>[]>
export type Dependencies = {
  query: Query
  transaction<T>(run: (query: Query) => Promise<T>): Promise<T>
  availability(date: string): Promise<string[]>
  leadTime(date: string, window: string): void
  locate(input: { zip: string; address: string }): Promise<{ lat: number; lng: number; city?: string; precision?: string }>
  boundaryHash?: string
  createSession(request: Request, input: ApprovalInput): Promise<string>
  checkRisk(sessionId: string, phone: string, address: string): Promise<void>
  newJobId(): string
  notify(job: Record<string, any>, event: 'created' | 'canceled'): void
  notificationEnv: GoogleActionsEnv & { CUSTOMER_BOOKING_EMAIL_ENABLED?: string }
  confirmationUrl: string
}
const summary = (job: Record<string, any>) => ({ bookingId: job.id, status: job.status,
  date: job.service_date instanceof Date ? job.service_date.toISOString().slice(0, 10) : String(job.service_date).slice(0, 10), window: job.service_window, timezone: 'America/Indianapolis' })
export function createBackend(deps: Dependencies): McpBackend {
  async function settings(query = deps.query) {
    const [row] = await query('select settings,revision from receptionist_settings where singleton=true')
    if (!row) throw new McpError('business_policy_unavailable', 503)
    return validateReceptionistSettings({ ...row.settings, revision: row.revision })
  }
  async function area(config: ReceptionistSettings, zip: string, address: string) {
    const decision = serviceZipDecision(config, zip)
    if (decision.nextAction !== 'collectFullAddress' || address.length < 10) return decision
    try { return await serviceAreaDecision(config, zip, await deps.locate({ zip, address }), deps.boundaryHash) }
    catch { return { covered: false, nextAction: 'requestCallback', reason: 'address_verification_unavailable' } }
  }
  async function eligible(config: ReceptionistSettings, raw: unknown) {
    const input = slotsInput.parse(raw)
    calendarDate(input.date)
    const coverage = await area(config, input.zip, input.address)
    if (!coverage.covered) throw new McpError('address_requires_manual_review', 409)
    const service = serviceEligibility(config, input.service)
    if (!service.eligible) throw new McpError(service.reason, 409)
    return input
  }
  async function owned(query: Query, user: Principal, jobId: string, lock = false) {
    const [job] = await query(`select j.* from jobs j where j.id=$1 and exists
      (select 1 from mcp_operations m where m.job_id=j.id and m.principal=$2 and m.action='createBooking')${lock ? ' for update' : ''}`, [jobId, user.id])
    if (!job) throw new McpError('booking_not_found', 404)
    return job
  }
  return {
    async intent(token, user) {
      const [intent] = await deps.query('select action,details from mcp_intents where token_hash=$1 and principal=$2 and expires_at>now()', [await digest(token), user.id])
      if (!intent) throw new McpError('confirmation_not_found', 404)
      return intent
    },
    async limit(key) {
      const [row] = await deps.query(`insert into mcp_rate_limits(key_hash,minute,requests)
        values($1,floor(extract(epoch from now())/60)::bigint,1)
        on conflict(key_hash,minute) do update set requests=mcp_rate_limits.requests+1
        returning requests`, [key])
      return Number(row?.requests) <= 60
    },
    async audit(tool, principal, outcome) {
      await deps.query('insert into mcp_audit(tool,principal,outcome) values($1,$2,$3)', [tool, principal, outcome])
    },
    async approve(input, user, request) {
      if (input.action === 'createBooking') {
        if (!user.phone || user.phone !== input.details.phone) throw new McpError('verified_phone_required', 403)
        const config = await settings()
        await eligible(config, slotsInput.strip().parse(input.details))
        deps.leadTime(input.details.date, input.details.window)
      } else { await owned(deps.query, user, input.details.bookingId) }
      const sessionId = await deps.createSession(request, input)
      await deps.checkRisk(sessionId, user.phone, input.action === 'createBooking' ? input.details.address : '')
      const token = crypto.randomUUID()
      await deps.query(`insert into mcp_approvals(token_hash,principal,action,payload_hash,session_id,expires_at)
        values($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
      [await digest(token), user.id, input.action, await digest(JSON.stringify(input.details)), sessionId])
      return { confirmationToken: token, expiresIn: 600, confirmed: false }
    },
    async execute(tool, args, user) {
      if (tool === 'getBookingStatus') {
        if (!user) throw new McpError('authorization_required', 401)
        return summary(await owned(deps.query, user, String(args.bookingId)))
      }
      if (tool === 'createBooking' || tool === 'cancelBooking') {
        if (!user) throw new McpError('authorization_required', 401)
        const { confirmationToken, ...raw } = args
        const input = tool === 'createBooking' ? bookingInput.parse(raw) : cancelInput.parse(raw)
        const payloadHash = await digest(JSON.stringify(input))
        const [existing] = await deps.query('select job_id from mcp_operations where principal=$1 and idempotency_key=$2', [user.id, input.idempotencyKey])
        const [approved] = await deps.query(`select token_hash from mcp_approvals where principal=$1 and action=$2 and payload_hash=$3 and expires_at>now()`, [user.id, tool, payloadHash])
        if (!existing && !approved && !confirmationToken) {
          if (tool === 'createBooking') {
            const booking = bookingInput.parse(raw)
            if (!user.phone || user.phone !== booking.phone) throw new McpError('verified_phone_required', 403)
            await eligible(await settings(), slotsInput.strip().parse(booking))
          } else { await owned(deps.query, user, cancelInput.parse(raw).bookingId) }
          const token = crypto.randomUUID()
          await deps.query(`insert into mcp_intents(token_hash,principal,action,details,expires_at) values($1,$2,$3,$4::jsonb,now()+interval '10 minutes')`, [await digest(token), user.id, tool, JSON.stringify(input)])
          return { confirmed: false, confirmationRequired: true, confirmationUrl: `${deps.confirmationUrl}?intent=${token}`, instruction: 'Open this secure page, review and confirm. Then retry this tool with identical details and idempotencyKey. No appointment has been created.' }
        }
        const outcome = await deps.transaction(async query => {
          // Serialize all mutations by this identity, including retries with different tokens.
          await query('select pg_advisory_xact_lock(hashtextextended($1,0))', [user.id])
          const [previous] = await query('select * from mcp_operations where principal=$1 and idempotency_key=$2', [user.id, input.idempotencyKey])
          if (previous) {
            if (previous.payload_hash !== payloadHash || previous.action !== tool) throw new McpError('idempotency_conflict', 409)
            return { job: await owned(query, user, previous.job_id), fresh: false }
          }
          const [approval] = await query(`select * from mcp_approvals where token_hash=$1 and principal=$2
            and action=$3 and payload_hash=$4 and expires_at>now() for update`,
          [confirmationToken ? await digest(String(confirmationToken)) : approved?.token_hash, user.id, tool, payloadHash])
          if (!approval) throw new McpError('customer_confirmation_required', 403)
          let job: Record<string, any>
          if (tool === 'createBooking') {
            const booking = bookingInput.parse(raw)
            if (!user.phone || user.phone !== booking.phone) throw new McpError('verified_phone_required', 403)
            // Lock the same live configuration used by Retell against concurrent policy edits.
            await query('select singleton from receptionist_settings where singleton=true for share')
            await eligible(await settings(query), slotsInput.strip().parse(booking))
            deps.leadTime(booking.date, booking.window)
            if (!(await deps.availability(booking.date)).includes(booking.window)) throw new McpError('slot_unavailable', 409)
            await deps.checkRisk(approval.session_id, booking.phone, booking.address)
            job = { id: deps.newJobId(), customer: booking.customer, phone: booking.phone, email: booking.email,
              address: `${booking.address}, ${booking.zip}`, appliance: booking.service.appliance, issue: booking.service.issue,
              details: '', job_text: '', service_date: booking.date, service_window: booking.window,
              status: 'scheduled', invoice: 0, paid: false, finance_items: [], payments: [], model_photo_attachments: [],
              created_by_user_id: null, booking_source: 'website', lat: null, lng: null }
            const receipt = { requestId: `mcp_${await digest(`${user.id}:${booking.idempotencyKey}`)}`, sessionId: approval.session_id, payloadHash }
            const statements = bookingPersistenceStatements(receipt, job, deps.notificationEnv, null)
            let rows: Record<string, any>[] = []
            for (const statement of statements) rows = await query(statement.text, statement.values)
            const saved = rows.find(row => row.request_id === receipt.requestId && row.payload_hash === payloadHash && row.job?.id === job.id)
            if (!saved) throw new McpError('slot_unavailable', 409)
            job = saved.job
            await query("update jobs set booking_source_detail='mcp_assistant' where id=$1", [job.id])
            job.booking_source_detail = 'mcp_assistant'
          } else {
            const cancel = cancelInput.parse(raw)
            job = await owned(query, user, cancel.bookingId, true)
            if (!['new', 'scheduled', 'canceled'].includes(job.status) || job.paid || (job.payments?.length || 0) > 0) throw new McpError('cancellation_requires_owner_review', 409)
            const [updated] = await query("update jobs set status='canceled' where id=$1 returning *", [job.id])
            job = updated
          }
          await query('insert into mcp_operations(principal,idempotency_key,action,payload_hash,job_id) values($1,$2,$3,$4,$5)', [user.id, input.idempotencyKey, tool, payloadHash, job.id])
          await query('delete from mcp_approvals where token_hash=$1', [approval.token_hash])
          await query('insert into mcp_audit(tool,principal,outcome) values($1,$2,$3)', [tool, user.id, 'committed'])
          return { job, fresh: true }
        })
        if (outcome.fresh) deps.notify(outcome.job, tool === 'createBooking' ? 'created' : 'canceled')
        return { ...summary(outcome.job), confirmed: outcome.job.status === 'scheduled', canceled: outcome.job.status === 'canceled' }
      }
      const config = await settings()
      switch (tool) {
        case 'getBusinessInfo': return { name: 'Alex Appliance Repair', phone: config.publicPhone || null, timezone: 'America/Indianapolis' }
        case 'getServices': return { appliances: config.appliances, builtInMicrowaveOvenCombination: config.appliances.includes('Oven repair'), eligibilityCheckRequired: true }
        case 'getBusinessPolicies': return { diagnosticFee: config.diagnosticFee || null, serviceZips: config.serviceZips,
          zipOnlyZips: config.zipOnlyZips || [], zipCoverage: config.zipCoverage || {},
          suspectedSealedSystemDiagnostic: config.suspectedSealedSystemDiagnostic,
          excluded: ['Refrigerant recharge', 'Compressor replacement', 'Sealed-system repair, coils, filter-driers or brazing', 'Over-the-range or countertop microwave repair'],
          confirmationRequired: true, availabilityIsReservation: false }
        case 'checkServiceArea': return area(config, String(args.zip), String(args.address))
        case 'getAvailableSlots': {
          const input = await eligible(config, args)
          return { date: input.date, windows: await deps.availability(input.date), reserved: false, timezone: 'America/Indianapolis' }
        }
        default: throw new McpError('unknown_tool', 404)
      }
    },
  }
}
