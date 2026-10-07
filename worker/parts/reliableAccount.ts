import type { PartResult } from '../../shared/parts'
import { SupplierAuthError, type AuthAdapter, type SupplierSession } from './supplierAuth'

const origin = 'https://reliableparts.net'
export class ReliableAccount implements AuthAdapter {
  readonly supplier = 'reliable' as const
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  async login(username: string, password: string, signal: AbortSignal): Promise<SupplierSession> {
    const response = await this.request(origin + '/us-api/accountapp/v1/security/api/auth/login', {
      method: 'POST', redirect: 'manual', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, redirectUrl: null }),
    })
    console.log(JSON.stringify({ event: 'supplier_auth_http', supplier: 'reliable', step: 'login', httpStatus: response.status }))
    if (response.status === 404) {
      const body = await response.text()
      const credentialError = /incorrect|invalid (?:user|password|credential)|user(?:name)? (?:is )?not found|bad credentials/i.test(body)
      console.log(JSON.stringify({event:'supplier_auth_rejected',supplier:'reliable',credentialError}))
      throw new SupplierAuthError(credentialError ? 'INVALID_CREDENTIALS' : 'HUMAN_ACTION_REQUIRED')
    }
    if (response.status === 429) throw new SupplierAuthError('ACCOUNT_LOCKED')
    if ([401, 400].includes(response.status)) throw new SupplierAuthError('INVALID_CREDENTIALS')
    if (response.status === 403 || !response.headers.get('content-type')?.includes('application/json')) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    if (!response.ok) throw new SupplierAuthError('LOGIN_FAILED')
    const data = await response.json() as { accessToken?: string; isFirstLogin?: boolean }
    console.log(JSON.stringify({ event: 'supplier_auth_shape', supplier: 'reliable', tokenPresent: typeof data.accessToken === 'string', firstLogin: data.isFirstLogin === true }))
    if (!data.accessToken || data.isFirstLogin) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    let claims: { accountId?: unknown; exp?: number }
    try {
      claims = JSON.parse(atob(data.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    } catch { throw new SupplierAuthError('LOGIN_FAILED') }
    // Claims only determine account selection/expiry; the supplier verifies the token.
    if (!claims.accountId) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    if (!claims.exp || claims.exp * 1000 < Date.now() + 30000) throw new SupplierAuthError('LOGIN_FAILED')
    return { value: data.accessToken, expiresAt: claims.exp * 1000 }
  }
  async verify(session: SupplierSession, signal: AbortSignal) {
    const response = await this.request(origin + '/us-api/accountapp/v1/webuser/client', {
      redirect: 'manual', signal, headers: { Accept: 'application/json', Authorization: `Bearer ${session.value}` },
    })
    console.log(JSON.stringify({ event: 'supplier_auth_http', supplier: 'reliable', step: 'verify', httpStatus: response.status }))
    return response.ok && !!response.headers.get('content-type')?.includes('application/json')
  }
  async quote(part: PartResult, session: SupplierSession, signal: AbortSignal): Promise<PartResult> {
    const match = decodeURIComponent(new URL(part.productUrl).hash).match(/^#\/part\/([A-Z0-9]+)  /)
    if (!match) throw new SupplierAuthError('LOGIN_FAILED')
    const response = await this.request(origin + '/us-api/navapp/v1/product/search', {
      method: 'POST', redirect: 'manual', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.value}` },
      body: JSON.stringify({ products: [{ productNumber: part.partNumber, manufacturerCode: match[1] }] }),
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new SupplierAuthError('LOGIN_FAILED')
    const data = await response.json() as Record<string, unknown>[]
    if (!Array.isArray(data)) throw new SupplierAuthError('LOGIN_FAILED')
    const product = data.find(p => p.productNumber === part.partNumber && p.manufacturerCode === match[1])
    if (!product) return part
    // Retail price and unauthenticated false stock defaults are deliberately ignored.
    const price = product.partnerPrice
    const unitCostCents = typeof price === 'number' && Number.isFinite(price) && price >= 0 && price <= 1000000 ? Math.round(price * 100) : null
    const availability = product.state === 'In Stock' && product.inStock === true ? 'in_stock' : 'unknown'
    return { ...part, unitCostCents, availability, retrievedAt: new Date().toISOString() }
  }
}
