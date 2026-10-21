import type { NeonQueryFunction } from '@neondatabase/serverless'

export async function processReceptionistCallbackPush(sql: NeonQueryFunction<false, false>, send: (callId: string) => Promise<void>) {
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
