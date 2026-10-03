export type DownloadTicket = {
  jobId: string
  attachmentId: string
  sessionHash: string
  fingerprint: string
  expires: number
}

async function signingKey(secret: string) {
  if (!secret) throw new Error('Attachment downloads are not configured')
  return crypto.subtle.importKey('raw', new TextEncoder().encode(`attachment-download-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signDownload(ticket: Omit<DownloadTicket, 'expires'>, secret: string, now = Date.now()) {
  const payload = btoa(JSON.stringify({ ...ticket, expires: now + 300000 }))
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), new TextEncoder().encode(payload))
  return `${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`
}

export async function verifyDownload(value: string, secret: string, now = Date.now()): Promise<DownloadTicket | null> {
  try {
    if (value.length > 4096) return null
    const [payload, signature, extra] = value.split('.')
    if (!payload || !signature || extra !== undefined) return null
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), Uint8Array.from(atob(signature), c => c.charCodeAt(0)), new TextEncoder().encode(payload))
    if (!valid) return null
    const ticket = JSON.parse(atob(payload)) as DownloadTicket
    if (!Number.isFinite(ticket.expires) || ticket.expires <= now || ticket.expires > now + 300000) return null
    if (![ticket.jobId, ticket.attachmentId, ticket.sessionHash, ticket.fingerprint].every(v => typeof v === 'string' && v.length > 0)) return null
    return ticket
  } catch { return null }
}

export function downloadHeaders(filename: string) {
  const safe = String(filename || 'attachment').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim().slice(0, 180) || 'attachment'
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}
