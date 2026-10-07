import type { Supplier } from '../../shared/parts'
import type { PartsSql } from './storage'

export type AuthStatus = 'CONNECTED' | 'REAUTHENTICATED' | 'NOT_CONFIGURED' | 'INVALID_CREDENTIALS' | 'MFA_REQUIRED' | 'HUMAN_ACTION_REQUIRED' | 'ACCOUNT_LOCKED' | 'LOGIN_FAILED' | 'LOGIN_TIMEOUT' | 'AUTH_BUSY'
export class SupplierAuthError extends Error {
  constructor(public readonly status: AuthStatus) { super(status) }
}
export type SupplierSecrets = { RELIABLE_USERNAME?: string; RELIABLE_PASSWORD?: string; MARCONE_USERNAME?: string; MARCONE_PASSWORD?: string; SUPPLIER_SESSION_KEY?: string }
export type SupplierSession = { value: string; expiresAt: number }
export interface AuthAdapter {
  supplier: Supplier
  protocolVersion?: string
  login(username: string, password: string, signal: AbortSignal): Promise<SupplierSession>
  verify(session: SupplierSession, signal: AbortSignal): Promise<boolean>
}
export const authSchema = `create table if not exists supplier_auth_state (
  supplier text primary key check(supplier in ('reliable','marcone')), revision text not null,
  envelope text, expires_at timestamptz, status text not null default 'LOGIN_FAILED',
  lock_id text, lock_until timestamptz, retry_at timestamptz,
  updated_at timestamptz not null default now()
)`
const encoder = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
const un64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))
async function keyBytes(key: string) {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new SupplierAuthError('NOT_CONFIGURED')
  return Uint8Array.from(key.match(/../g)!, byte => parseInt(byte, 16))
}
export async function sealSession(key: string, scope: string, session: SupplierSession) {
  const cryptoKey = await crypto.subtle.importKey('raw', await keyBytes(key), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(scope) }, cryptoKey, encoder.encode(JSON.stringify(session)))
  return `v1.${b64(iv)}.${b64(new Uint8Array(ciphertext))}`
}
export async function openSession(key: string, scope: string, envelope: string): Promise<SupplierSession> {
  const [version, iv, data] = envelope.split('.')
  if (version !== 'v1') throw new SupplierAuthError('LOGIN_FAILED')
  const cryptoKey = await crypto.subtle.importKey('raw', await keyBytes(key), 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(iv), additionalData: encoder.encode(scope) }, cryptoKey, un64(data))
  const session = JSON.parse(new TextDecoder().decode(plain))
  if (typeof session.value !== 'string' || !Number.isFinite(session.expiresAt)) throw new SupplierAuthError('LOGIN_FAILED')
  return session
}
function credentials(env: SupplierSecrets, supplier: Supplier) {
  const username = supplier === 'reliable' ? env.RELIABLE_USERNAME : env.MARCONE_USERNAME
  const password = supplier === 'reliable' ? env.RELIABLE_PASSWORD : env.MARCONE_PASSWORD
  if (!username || !password || !env.SUPPLIER_SESSION_KEY) throw new SupplierAuthError('NOT_CONFIGURED')
  return { username, password, key: env.SUPPLIER_SESSION_KEY }
}
export function authConfigured(env: SupplierSecrets, supplier: Supplier) {
  try { const { key } = credentials(env, supplier); return /^[a-fA-F0-9]{64}$/.test(key) } catch { return false }
}
const terminal = new Set<AuthStatus>(['INVALID_CREDENTIALS','ACCOUNT_LOCKED','MFA_REQUIRED','HUMAN_ACTION_REQUIRED'])

// A database lease coordinates all Worker instances, not just requests in one isolate.
// A changed credential revision clears a stop; repeated bad passwords never auto-retry.
export async function supplierSession(sql: PartsSql, env: SupplierSecrets, adapter: AuthAdapter): Promise<{session: SupplierSession; status: 'CONNECTED' | 'REAUTHENTICATED'}> {
  const { username, password, key } = credentials(env, adapter.supplier)
  const hmacKey = await crypto.subtle.importKey('raw', await keyBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const revision = b64(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(JSON.stringify([adapter.supplier,username,password,...(adapter.protocolVersion ? [adapter.protocolVersion] : [])])))))
  const scope = `${adapter.supplier}:${revision}`
  await sql.query(authSchema)
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const [state] = await sql.query('select *, updated_at::text as state_version from supplier_auth_state where supplier=$1', [adapter.supplier])
    if (state?.revision === revision) {
      if (terminal.has(state.status as AuthStatus)) throw new SupplierAuthError(state.status as AuthStatus)
      if (state.retry_at && new Date(String(state.retry_at)).getTime() > Date.now()) {
        console.log(JSON.stringify({event:'supplier_auth_cooldown',supplier:adapter.supplier}))
        throw new SupplierAuthError('LOGIN_FAILED')
      }
      if (state.envelope && new Date(String(state.expires_at)).getTime() > Date.now()+30000) {
        const session = await openSession(key, scope, String(state.envelope))
        if (await adapter.verify(session, AbortSignal.timeout(10000))) return { session, status: 'CONNECTED' }
      }
    }
    const lease = crypto.randomUUID()
    const claimed = await sql.query(`insert into supplier_auth_state(supplier,revision,lock_id,lock_until) values($1,$2,$3,now()+interval '90 seconds')
      on conflict(supplier) do update set revision=$2,lock_id=$3,lock_until=now()+interval '90 seconds',status='LOGIN_FAILED',envelope=null,expires_at=null,retry_at=null,updated_at=now()
      where (supplier_auth_state.lock_until is null or supplier_auth_state.lock_until<now())
      and (supplier_auth_state.revision<>$2 or (
        supplier_auth_state.status not in ('INVALID_CREDENTIALS','ACCOUNT_LOCKED','MFA_REQUIRED','HUMAN_ACTION_REQUIRED')
        and (supplier_auth_state.retry_at is null or supplier_auth_state.retry_at<now())
        and supplier_auth_state.updated_at <= $4::timestamptz)) returning supplier`,
    [adapter.supplier, revision, lease, state?.state_version || new Date().toISOString()])
    if (!claimed.length) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    let phase = 'login'
    try {
      const signal = AbortSignal.timeout(25000)
      const session = await adapter.login(username, password, signal)
      phase = 'verify'
      if (!Number.isFinite(session.expiresAt) || session.expiresAt < Date.now()+30000 || !await adapter.verify(session, signal)) throw new SupplierAuthError('LOGIN_FAILED')
      session.expiresAt = Math.min(session.expiresAt, Date.now()+20*60*1000)
      phase = 'encrypt'
      const envelope = await sealSession(key, scope, session)
      phase = 'save'
      const saved = await sql.query(`update supplier_auth_state set envelope=$3,expires_at=$4,status='CONNECTED',lock_id=null,lock_until=null,retry_at=null,updated_at=now()
        where supplier=$1 and lock_id=$2 returning supplier`, [adapter.supplier,lease,envelope,new Date(session.expiresAt).toISOString()])
      if (!saved.length) throw new SupplierAuthError('AUTH_BUSY')
      return { session, status: 'REAUTHENTICATED' }
    } catch (error) {
      const status = error instanceof SupplierAuthError ? error.status : error instanceof Error && error.name === 'TimeoutError' ? 'LOGIN_TIMEOUT' : 'LOGIN_FAILED'
      console.log(JSON.stringify({event:'supplier_auth_failure',supplier:adapter.supplier,phase,status}))
      await sql.query(`update supplier_auth_state set status=$3,envelope=null,expires_at=null,lock_id=null,lock_until=null,retry_at=now()+interval '5 minutes',updated_at=now()
        where supplier=$1 and lock_id=$2`,[adapter.supplier,lease,status])
      throw new SupplierAuthError(status)
    }
  }
  throw new SupplierAuthError('AUTH_BUSY')
}
