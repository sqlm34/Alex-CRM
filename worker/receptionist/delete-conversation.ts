import type { NeonQueryFunction } from '@neondatabase/serverless'
import { ReceptionistError } from '../../shared/receptionist'

export async function deleteConversation(sql: NeonQueryFunction<false, false>, id: string, actor: string,
  env: { RETELL_WEBHOOK_API_KEY?: string; RETELL_API_KEY?: string; RETELL_AGENT_ID?: string }) {
  const [call] = await sql.query('select provider,provider_call_id,ended_at from receptionist_calls where id=$1', [id])
  if (!call) {
    const [deleted] = await sql.query('select call_id from receptionist_deleted_calls where call_id=$1', [id])
    if (deleted) return { deleted: true }
    throw new ReceptionistError('Conversation not found', 404)
  }
  const key = env.RETELL_WEBHOOK_API_KEY || env.RETELL_API_KEY
  if (call.provider !== 'retell' || !key) throw new ReceptionistError('Conversation deletion is unavailable.', 503)
  if (!call.ended_at) {
    let status: Response
    try {
      status = await fetch(`https://api.retellai.com/v2/get-call/${encodeURIComponent(call.provider_call_id)}`, {
        headers: { Authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(10000),
      })
    } catch { throw new ReceptionistError('Unable to verify call status. Please try again.', 503) }
    if (!status.ok) throw new ReceptionistError('Unable to verify call status. Please try again.', 503)
    const live = await status.json() as { call_id?: string; call_status?: string }
    if (live.call_id !== call.provider_call_id) throw new ReceptionistError('Unable to verify call status. Please try again.', 503)
    if (!['ended', 'error'].includes(live.call_status || '')) throw new ReceptionistError('Wait until this call has ended before deleting it.', 409)
    // Recover a missing end webhook without guessing from the age of the call.
    await sql.query('update receptionist_calls set ended_at=coalesce(ended_at,now()) where id=$1', [id])
  }
  // Erase provider audio first; retain the CRM card if the provider cannot confirm.
  let result: Response
  try {
    result = await fetch(`https://api.retellai.com/v2/delete-call/${encodeURIComponent(call.provider_call_id)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(10000),
    })
  } catch { throw new ReceptionistError('Unable to delete the recording. Please try again.', 503) }
  let alreadyAbsent = result.status === 404
  // Retell documents missing assets as 422. Verify account access before treating
  // that response as a completed earlier delete (for a retry after a DB failure).
  if (result.status === 422 && env.RETELL_AGENT_ID) {
    try {
      const error = await result.json() as { message?: string }
      if (error.message === 'Cannot find requested asset under given api key.') {
        const account = await fetch(`https://api.retellai.com/get-agent/${encodeURIComponent(env.RETELL_AGENT_ID)}`, {
          headers: { Authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(8000),
        })
        alreadyAbsent = account.ok && (await account.json() as { agent_id?: string }).agent_id === env.RETELL_AGENT_ID
      }
    } catch { alreadyAbsent = false }
  }
  if (!result.ok && !alreadyAbsent) throw new ReceptionistError('Unable to delete the recording. Please try again.', 503)
  const [removed] = await sql.query('select receptionist_delete_conversation($1,$2) as deleted', [id, actor])
  if (!removed?.deleted) throw new ReceptionistError('Deletion was not confirmed. Please reload and try again.', 409)
  return { deleted: true }
}
