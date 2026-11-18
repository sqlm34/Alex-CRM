import type { NeonQueryFunction } from '@neondatabase/serverless'
import { ReceptionistError } from '../../shared/receptionist'

export const supportCategories = ['estimate_copy', 'missed_visit', 'customer_callback', 'business_solicitation'] as const
export function supportCategory(value: unknown): typeof supportCategories[number] {
  if (value === undefined) return 'customer_callback'
  if (!supportCategories.includes(value as typeof supportCategories[number])) throw new ReceptionistError('Invalid support category')
  return value as typeof supportCategories[number]
}

// This is an issue grouping key, never identity verification or job authorization.
export function callbackIssueKey(customer: string, phone: string, category: string) {
  return JSON.stringify([phone, customer.trim().toLowerCase().replace(/\s+/g, ' '), category])
}

export async function recordConfirmedCallback(sql: NeonQueryFunction<false, false>, input: {
  callId: string; customer: string; phone: string; reason: string; category: ReturnType<typeof supportCategory>
}) {
  const { callId, customer, phone, reason, category } = input
  // The caller has passed the authenticated tool's explicit confirmed:true guard.
  // Neither post-call summaries nor requests for a human enter this path.
  let rows
  try { rows = await sql.query(`with saved as (
    select * from receptionist_record_callback($1,$2,$3,$4,$5,$6)
  ), marked as (
    update receptionist_calls set outcome='callback_requested'
    where id=$1 and job_id is null and exists(select 1 from saved) returning id
  ) select * from saved`, [callId, customer, phone, reason, category, callbackIssueKey(customer, phone, category)]) }
  catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ReceptionistError('Callback already recorded with different details', 409)
    throw error
  }
  return rows[0]
}
