import { exactKeys, object, phoneNumber, ReceptionistError, textField } from '../../shared/receptionist'
import type { VoiceCall } from './retell'

type Sql = { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }
export type VipEnv = {
  VIP_CRYPTO_KEY?: string
  VIP_TRANSFER_ENABLED?: string
  VIP_APPROVED_DESTINATION_SHA256?: string
  VIP_AI_ROUTED_NUMBERS?: string
  RETELL_API_KEY?: string
  RETELL_TEST_PHONE?: string
}
type Config = { destination: string; trusted: string[]; salt: string; phraseHashes: string[]; response: string }
const neutral = { nextAction: 'continueReceptionist' }
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('')
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unbase64 = (value: string) => Uint8Array.from(atob(value), x => x.charCodeAt(0))
export const normalizeVipPhrase = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
async function key(secret: string, purpose: 'encryption' | 'hash') {
  const bytes = unbase64(secret)
  if (bytes.length !== 32) throw Error('VIP configuration unavailable')
  const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey'])
  const algorithm = purpose === 'encryption' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256', length: 256 }
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('receptionist-vip-v1'), info: encoder.encode(purpose) }, material, algorithm, false, purpose === 'encryption' ? ['encrypt', 'decrypt'] : ['sign'])
}
async function digest(value: string, secret: string) { return hex(await crypto.subtle.sign('HMAC', await key(secret, 'hash'), encoder.encode(value))) }
export async function sealVip(config: Config, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('vip-config-v1') }, await key(secret, 'encryption'), encoder.encode(JSON.stringify(config)))
  return `${base64(iv)}.${base64(new Uint8Array(cipher))}`
}
async function openVip(value: string, secret: string): Promise<Config> {
  const [iv, cipher] = value.split('.')
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode('vip-config-v1') }, await key(secret, 'encryption'), unbase64(cipher))
  return JSON.parse(new TextDecoder().decode(data))
}
export async function destinationFingerprint(destination: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(phoneNumber(destination)))) }
export function safeVipDestination(destination: string, publicPhone: string, env: VipEnv) {
  const phone = phoneNumber(destination)
  const blocked = [publicPhone, env.RETELL_TEST_PHONE, ...(env.VIP_AI_ROUTED_NUMBERS || '').split(',')].filter((x): x is string => Boolean(x?.trim())).map(phoneNumber)
  if (!publicPhone || !env.RETELL_TEST_PHONE || blocked.includes(phone)) throw new ReceptionistError('Destination must be a separately verified private line', 400)
  return phone
}
export async function prepareVipConfig(input: unknown, previous: Config | undefined, secret: string, publicPhone: string, env: VipEnv): Promise<Config> {
  const p = object(input)
  exactKeys(p, ['enabled', 'revision', 'destination', 'trustedCallers', 'passphrases', 'response'])
  if (typeof p.enabled !== 'boolean' || !Number.isSafeInteger(p.revision) || Number(p.revision) < 0) throw new ReceptionistError('Invalid VIP settings')
  const destination = safeVipDestination(textField(p, 'destination', 30, true) || previous?.destination || '', publicPhone, env)
  let trusted = previous?.trusted || []
  if (p.trustedCallers !== undefined) {
    if (!Array.isArray(p.trustedCallers) || p.trustedCallers.length > 50) throw new ReceptionistError('Invalid trusted caller list')
    trusted = [...new Set(p.trustedCallers.map(x => phoneNumber(String(x))))]
  }
  let salt = previous?.salt || crypto.randomUUID(), phraseHashes = previous?.phraseHashes || []
  if (p.passphrases !== undefined) {
    if (!Array.isArray(p.passphrases) || !p.passphrases.length || p.passphrases.length > 4) throw new ReceptionistError('Provide one to four passphrase spellings')
    salt = crypto.randomUUID(); phraseHashes = []
    for (const phrase of p.passphrases) {
      if (typeof phrase !== 'string' || phrase.length > 100) throw new ReceptionistError('Invalid passphrase')
      const normalized = normalizeVipPhrase(phrase)
      if (normalized.length < 6 || normalized.split(' ').length > 8) throw new ReceptionistError('Passphrase must have at least six characters and at most eight words')
      phraseHashes.push(await digest(`${salt}:${normalized}`, secret))
    }
  }
  const response = textField(p, 'response', 160)
  if (!trusted.length || !phraseHashes.length) throw new ReceptionistError('Private destination, trusted callers and passphrase are required')
  // Never allow the public transfer response to echo a configured secret or phone.
  if (/\d/.test(response) || await phraseMatches(response, { salt, phraseHashes }, secret)) throw new ReceptionistError('Transfer response cannot contain private information')
  return { destination, trusted, salt, phraseHashes, response }
}
export async function phraseMatches(utterance: string, config: Pick<Config, 'salt' | 'phraseHashes'>, secret: string, maxLength = 500, maxWords = 40) {
  const words = normalizeVipPhrase(utterance).split(' ')
  if (utterance.length > maxLength || words.length > maxWords) return false
  let match = false
  const signingKey = await key(secret, 'hash')
  for (let start = 0; start < words.length; start++) for (let size = 1; size <= 8 && start + size <= words.length; size++) {
    const actual = hex(await crypto.subtle.sign('HMAC', signingKey, encoder.encode(`${config.salt}:${words.slice(start, start + size).join(' ')}`)))
    for (const expected of config.phraseHashes) {
      let difference = actual.length ^ expected.length
      for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0)
      match = match || difference === 0
    }
  }
  return match
}
// Reject secret-bearing text before any ordinary tool can persist or echo it.
// This is independent of whether the model requested VIP authorization first.
export async function vipTextSafe(sql: Sql, env: VipEnv, values: unknown[]) {
  if (env.VIP_TRANSFER_ENABLED !== 'true') return true
  try {
    const [row] = await sql.query('select encrypted_config from receptionist_vip_settings where singleton=true')
    if (!row?.encrypted_config) return true
    const config = await openVip(String(row.encrypted_config), env.VIP_CRYPTO_KEY || '')
    for (const value of values) {
      if (typeof value !== 'string') continue
      if (value.length > 4000) return false
      const words = normalizeVipPhrase(value).split(' ')
      if (words.length > 400 || await phraseMatches(value, config, env.VIP_CRYPTO_KEY || '', 4000, 400)) return false
    }
    return true
  } catch { return false }
}
export async function vipSettings(sql: Sql, env: VipEnv, input?: unknown, publicPhone = '', actor = '') {
  const [schema] = await sql.query("select to_regclass('receptionist_vip_settings') is not null as ready")
  if (!schema?.ready) {
    if (input !== undefined) throw new ReceptionistError('VIP migration pending', 409)
    return { ready: false, enabled: false, configured: false, revision: 0, trustedCount: 0, response: '' }
  }
  const [row] = await sql.query('select * from receptionist_vip_settings where singleton=true')
  let config: Config | undefined
  try { config = row?.encrypted_config ? await openVip(String(row.encrypted_config), env.VIP_CRYPTO_KEY || '') : undefined }
  catch {
    if (input !== undefined) throw new ReceptionistError('VIP configuration unavailable', 503)
    return { ready: true, enabled: row?.enabled === true, configured: true, revision: row?.revision || 0,
      trustedCount: 0, response: '', configurationUnavailable: true, releaseEnabled: false }
  }
  if (input !== undefined) {
    const p = object(input)
    // Emergency disable has a separate endpoint that never decrypts settings.
    config = await prepareVipConfig(p, config, env.VIP_CRYPTO_KEY || '', publicPhone, env)
    const saved = await sql.query(`with changed as (update receptionist_vip_settings set enabled=$1,encrypted_config=$2,revision=revision+1,updated_at=now()
      where singleton=true and revision=$3 returning revision), audit as (
      insert into receptionist_audit(action,actor_id) select 'vip_settings_updated',$4 from changed) select revision from changed`,
    [p.enabled, await sealVip(config, env.VIP_CRYPTO_KEY || ''), p.revision, actor])
    if (!saved.length) throw new ReceptionistError('VIP settings changed; reload', 409)
    return { ready: true, enabled: p.enabled, configured: true, revision: saved[0].revision, trustedCount: config.trusted.length, response: config.response }
  }
  return { ready: true, enabled: row?.enabled === true, configured: Boolean(config), revision: row?.revision || 0, trustedCount: config?.trusted.length || 0, response: config?.response || '', releaseEnabled: env.VIP_TRANSFER_ENABLED === 'true' }
}
export async function authorizeVip(sql: Sql, env: VipEnv, call: VoiceCall, utterance: string, publicPhone: string, send: typeof fetch = fetch) {
  const callId = `retell:${call.id}`
  if (env.VIP_TRANSFER_ENABLED !== 'true' || !env.VIP_CRYPTO_KEY || !env.RETELL_API_KEY || call.ended) return neutral
  try {
    const [row] = await sql.query('select enabled,encrypted_config,revision from receptionist_vip_settings where singleton=true')
    if (!row?.enabled || !row.encrypted_config) return neutral
    const caller = phoneNumber(call.caller)
    const bucket = await digest(`caller:${caller}`, env.VIP_CRYPTO_KEY)
    await sql.query('delete from receptionist_vip_limits where expires_at<now()')
    // Atomic counters protect parallel requests and repeated calls from one caller.
    const [limit] = await sql.query(`insert into receptionist_vip_limits(bucket,attempts,expires_at) values($1,1,now()+interval '15 minutes')
      on conflict(bucket) do update set attempts=case when receptionist_vip_limits.expires_at<now() then 1 else receptionist_vip_limits.attempts+1 end,
      expires_at=case when receptionist_vip_limits.expires_at<now() then now()+interval '15 minutes' else receptionist_vip_limits.expires_at end returning attempts`, [bucket])
    if (Number(limit?.attempts) > 5) return neutral
    const claimed = await sql.query(`insert into receptionist_vip_attempts(call_id,status) values($1,'checking')
      on conflict(call_id) do update set attempts=receptionist_vip_attempts.attempts+1,status='checking',updated_at=now()
      where receptionist_vip_attempts.status='denied' and receptionist_vip_attempts.attempts<3 returning call_id`, [callId])
    if (!claimed.length) return neutral
    const config = await openVip(String(row.encrypted_config), env.VIP_CRYPTO_KEY)
    const destination = safeVipDestination(config.destination, publicPhone, env)
    const allowed = config.trusted.includes(caller) && await phraseMatches(utterance, config, env.VIP_CRYPTO_KEY)
      && await destinationFingerprint(destination) === env.VIP_APPROVED_DESTINATION_SHA256
    if (!allowed) {
      await sql.query("update receptionist_vip_attempts set status='denied',updated_at=now() where call_id=$1", [callId])
      return neutral
    }
    const active = await sql.query(`update receptionist_vip_attempts set status='authorizing',updated_at=now() where call_id=$1 and status='checking'
      and exists(select 1 from receptionist_vip_settings where singleton=true and enabled=true and revision=$2)
      and exists(select 1 from receptionist_calls where id=$1 and ended_at is null) returning call_id`, [callId, row.revision])
    if (!active.length) return neutral
    // Documented Update Live Call API arms a predefined built-in transfer target.
    // The destination is never returned as a custom-tool result or prompt text.
    const response = await send(`https://api.retellai.com/v2/update-live-call/${encodeURIComponent(call.id)}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields_to_override: { override_dynamic_variables: { vip_transfer_destination: destination } } }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok || (await response.json() as { success?: boolean }).success !== true) throw Error('Provider unavailable')
    await sql.query("update receptionist_vip_attempts set status='authorized',updated_at=now() where call_id=$1 and status='authorizing'", [callId])
    return { nextAction: 'vipTransfer', message: config.response }
  } catch {
    // An ambiguous network failure must not cause another dial attempt.
    await sql.query("update receptionist_vip_attempts set status='unknown',updated_at=now() where call_id=$1 and status in ('checking','authorizing')", [callId]).catch(() => {})
    return neutral
  }
}
