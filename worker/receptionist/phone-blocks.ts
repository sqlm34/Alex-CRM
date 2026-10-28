import type { NeonQueryFunction } from '@neondatabase/serverless'
import { exactKeys, object, phoneNumber, ReceptionistError, textField } from '../../shared/receptionist'
import { limitedBody, verifyRetell } from './retell'

export function blockedPhone(value: unknown) {
  if (typeof value !== 'string') throw new ReceptionistError('Phone number required')
  const compact = value.trim().replace(/[\s().-]/g, '')
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact
  return phoneNumber(compact)
}

export async function phoneBlockManagement(request: Request, sql: NeonQueryFunction<false, false>, actor: string) {
  if (!actor) throw new ReceptionistError('Owner access required', 403)
  if (request.method === 'GET') {
    const search = (new URL(request.url).searchParams.get('search') || '').trim().slice(0, 100)
    const phone = new URL(request.url).searchParams.get('phone')
    const rows = await sql.query(`select phone,blocked,reason,created_at,updated_at from receptionist_phone_blocks
      where position(lower($1) in lower(phone || ' ' || reason))>0 and ($2::text is null or phone=$2) order by updated_at desc limit 500`, [search, phone ? blockedPhone(phone) : null])
    const history = phone ? await sql.query(`select blocked,reason,created_at from receptionist_phone_block_history
      where phone=$1 order by created_at desc limit 100`, [blockedPhone(phone)]) : []
    return { rows, history }
  }
  if (request.method !== 'POST') throw new ReceptionistError('Method not allowed', 405)
  const input = object(JSON.parse(await limitedBody(request, 2048)))
  exactKeys(input, ['phone', 'blocked', 'reason', 'confirmed', 'requestId'])
  if (input.confirmed !== true || typeof input.blocked !== 'boolean') throw new ReceptionistError('Confirm the number status change')
  const phone = blockedPhone(input.phone)
  const reason = textField(input, 'reason', 500, true)
  const requestId = textField(input, 'requestId', 36)
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) throw new ReceptionistError('Invalid request ID')
  // One statement commits the status and audit together. Replays never overwrite a later unblock.
  const rows = await sql.query(`with changed as (
    insert into receptionist_phone_blocks(phone,blocked,reason,updated_by)
    select $1,$2,$3,$4 where not exists(select 1 from receptionist_phone_block_history where request_id=$5::uuid)
    on conflict(phone) do update set blocked=excluded.blocked,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()
    returning phone,blocked,reason
  ), audited as (
    insert into receptionist_phone_block_history(request_id,phone,blocked,reason,actor_id)
    select $5::uuid,phone,blocked,reason,$4 from changed returning phone
  ) select phone,blocked,reason from changed`, [phone,input.blocked,reason,actor,requestId]).catch(error=>{
    // A concurrent retry can race the audit insert. Its entire statement rolls back.
    if(error?.code==='23505')return []
    throw error
  })
  if (rows.length) return rows[0]
  const [previous] = await sql.query('select phone,blocked,reason,actor_id from receptionist_phone_block_history where request_id=$1::uuid', [requestId])
  if (!previous || previous.phone !== phone || previous.blocked !== input.blocked || previous.reason !== reason || previous.actor_id !== actor) throw new ReceptionistError('Request ID already used',409)
  return { phone, blocked: previous.blocked, reason: previous.reason, replay: true }
}

export async function inboundPhoneBlock(request: Request, env: { RETELL_WEBHOOK_API_KEY?: string; RETELL_TEST_PHONE?: string }, sql: NeonQueryFunction<false,false>) {
  if (request.method !== 'POST') throw new ReceptionistError('Method not allowed',405)
  if (!env.RETELL_WEBHOOK_API_KEY || !env.RETELL_TEST_PHONE) throw new ReceptionistError('Inbound check unavailable',503)
  const raw = await limitedBody(request)
  if (!await verifyRetell(raw, request.headers.get('x-retell-signature') || '', env.RETELL_WEBHOOK_API_KEY)) throw new ReceptionistError('Invalid signature',401)
  const payload = object(JSON.parse(raw))
  if (payload.event !== 'call_inbound') throw new ReceptionistError('Unsupported inbound event')
  const incoming = object(payload.call_inbound)
  if (incoming.to_number !== env.RETELL_TEST_PHONE) throw new ReceptionistError('Unrecognized destination',403)
  let phone: string
  try { phone = blockedPhone(incoming.from_number) }
  catch { return { call_inbound: {} } } // Private/unavailable caller ID is not a blacklist match.
  const [entry] = await sql.query('select blocked from receptionist_phone_blocks where phone=$1', [phone])
  return { call_inbound: entry?.blocked ? { reject: true } : {} }
}
