import { object, ReceptionistError, textField } from '../../shared/receptionist'

// Retell's official SDK signs rawBody + millisecond timestamp with HMAC-SHA256.
// https://github.com/RetellAI/retell-typescript-sdk/blob/main/src/lib/webhook_auth.ts
export async function verifyRetell(raw: string, signature: string, secret: string, now = Date.now()) {
  const match = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature)
  if (!match || !secret) return false
  const timestamp = Number(match[1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300000) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const bytes = Uint8Array.from(match[2].match(/../g)!, x => parseInt(x, 16))
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(raw + match[1]))
}
export async function limitedBody(request: Request, limit = 65536) {
  if (!request.body) throw new ReceptionistError('Missing body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); throw new ReceptionistError('Payload too large', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
export type VoiceCall = { id: string; caller: string; destination: string; provider: 'retell'; ended: boolean }
export function retellCall(value: unknown, agentId: string, allowedNumber: string): VoiceCall {
  const call = object(value)
  if (call.agent_id !== agentId || call.to_number !== allowedNumber || call.direction !== 'inbound' || call.call_type !== 'phone_call') throw new ReceptionistError('Call not authorized', 403)
  const id = textField(call, 'call_id', 100)
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ReceptionistError('Invalid call ID')
  return { id, caller: textField(call, 'from_number', 30), destination: allowedNumber, provider: 'retell', ended: ['ended', 'error'].includes(String(call.call_status)) }
}

export function retellMetrics(value: unknown, now = Date.now()) {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const number = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null
  const call = record(value)
  const timestamp = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 946684800000 && v <= now + 300000 ? v : null
  const start = timestamp(call.start_timestamp), end = timestamp(call.end_timestamp)
  return {
    startedAt: start === null ? null : new Date(start).toISOString(),
    endedAt: start !== null && end !== null && end >= start ? new Date(end).toISOString() : null,
    // Retell combined_cost is cents; missing metadata must not become zero.
    costCents: number(record(call.call_cost).combined_cost, 100_000_000),
    latencyMs: number(record(record(call.latency).e2e).p50, 300_000),
    durationMs: (Number.isSafeInteger(call.duration_ms) ? number(call.duration_ms, 86400000) : null) ?? (start !== null && end !== null && end >= start ? number(end - start, 86400000) : null),
    disconnectReason: ['user_hangup', 'agent_hangup', 'call_transfer', 'inactivity', 'max_duration_reached'].includes(String(call.disconnection_reason)) ? String(call.disconnection_reason) : null,
  }
}
