import { CookieJar } from 'tough-cookie'
import { parseHTML } from 'linkedom'
import type { PartResult } from '../../shared/parts'
import { SupplierAuthError, type AuthAdapter, type SupplierSession } from './supplierAuth'

const origin = 'https://my.marcone.com'
export class MarconeAccount implements AuthAdapter {
  readonly supplier = 'marcone' as const
  // One retry after the owner explicitly reconfirmed credentials on 2026-10-07.
  readonly protocolVersion = 'http-v3-owner-reconfirmed-20261007'
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  private async send(path: string, jar: CookieJar, signal: AbortSignal, body?: URLSearchParams): Promise<Response> {
    let url = new URL(path, origin)
    for (let redirects = 0; redirects < 4; redirects++) {
      if (url.origin !== origin || /logout/i.test(url.pathname)) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
      const response = await this.request(url.href, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal,
        headers: { 'User-Agent':'Alex-CRM/1.0 (parts lookup)', Accept:body?'application/json':'text/html', Cookie: await jar.getCookieString(url.href), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}) },
        ...(body ? { body: body.toString() } : {}),
      })
      console.log(JSON.stringify({event:'supplier_auth_http',supplier:'marcone',step:body?'login':'page',httpStatus:response.status}))
      for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url.href)
      if (response.status === 429) throw new SupplierAuthError('ACCOUNT_LOCKED')
      if (response.status === 403) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
      if (response.status >= 300 && response.status < 400) {
        if (body) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
        const location = response.headers.get('location')
        if (!location) throw new SupplierAuthError('LOGIN_FAILED')
        url = new URL(location, url); continue
      }
      if (!response.ok) throw new SupplierAuthError('LOGIN_FAILED')
      return response
    }
    throw new SupplierAuthError('LOGIN_FAILED')
  }
  async login(username: string, password: string, signal: AbortSignal): Promise<SupplierSession> {
    const jar = new CookieJar()
    const page = await this.send('/UserLogin', jar, signal)
    const { document } = parseHTML(await page.text())
    if (!document.querySelector('input[name="UserName"]') || !document.querySelector('input[name="Password"]')) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    const response = await this.send('/UserLogin/DoLogin', jar, signal, new URLSearchParams({ UserName: username, Password: password, code: '' }))
    if (!response.headers.get('content-type')?.includes('application/json')) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    const result = await response.json() as { Result?: boolean; Message?: string; SetShipToReadOnly?: boolean }
    const message = typeof result.Message === 'string' ? result.Message : ''
    const credentialError = /incorrect|invalid (?:user|password|credential)|user(?:name)? (?:is )?not found|bad credentials/i.test(message)
    console.log(JSON.stringify({event:'supplier_auth_result',supplier:'marcone',accepted:result.Result===true,accountSelection:result.SetShipToReadOnly===true,credentialError,step:['EmailPopup','TempPasswordPopup','OcAccountLock','blocked','subuserblocked'].includes(message)?message:'unspecified'}))
    if (credentialError) throw new SupplierAuthError('INVALID_CREDENTIALS')
    if (['blocked','subuserblocked','OcAccountLock'].includes(result.Message || '')) throw new SupplierAuthError('ACCOUNT_LOCKED')
    if (result.SetShipToReadOnly || ['EmailPopup','TempPasswordPopup'].includes(result.Message || '')) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    if (result.Result !== true) throw new SupplierAuthError('HUMAN_ACTION_REQUIRED')
    return { value: JSON.stringify(await jar.serialize()), expiresAt: Date.now() + 20 * 60 * 1000 }
  }
  async verify(session: SupplierSession, signal: AbortSignal) {
    const response = await this.send('/Home/Index', await CookieJar.deserialize(session.value), signal)
    const { document } = parseHTML(await response.text())
    return !!document.querySelector('a[href="/UserLogin/Logout"]')
  }
  async quote(part: PartResult, session: SupplierSession, signal: AbortSignal): Promise<PartResult> {
    const match = decodeURIComponent(new URL(part.productUrl).hash).match(/^#\/part\/([A-Z0-9]+) {2}/)
    if (!match) throw new SupplierAuthError('LOGIN_FAILED')
    // Supplier manufacturer codes differ: verified against Marcone's LG product pages.
    const make = match[1] === 'LGE' ? 'L-G' : match[1] === 'SMG' ? 'SAM' : match[1]
    const path = '/Product/Detail?' + new URLSearchParams({ Machine: '', Category: '', Part: part.partNumber, Make: make })
    const response = await this.send(path, await CookieJar.deserialize(session.value), signal)
    const { document } = parseHTML(await response.text())
    if (!document.querySelector('a[href="/UserLogin/Logout"]')) throw new SupplierAuthError('LOGIN_FAILED')
    const price = document.querySelector('#trPrice .priceblock_ourprice')?.textContent?.trim().match(/^\$([\d,]+)\.(\d{2})$/)
    const unitCostCents = price ? Number(price[1].replace(/,/g,'')) * 100 + Number(price[2]) : null
    if (unitCostCents !== null && (!Number.isSafeInteger(unitCostCents) || unitCostCents > 100000000)) throw new SupplierAuthError('LOGIN_FAILED')
    const stock = Array.from(document.querySelectorAll('.a-color-success')).map(e=>e.textContent?.trim().match(/^(\d+) In Stock$/)).find(Boolean)
    const quantity = stock ? Number(stock[1]) : null
    const identifiers = Array.from(document.querySelectorAll('td.partbig')).map(e=>e.textContent?.trim() || '')
    const exactOEM = identifiers.includes(part.partNumber)
    const exactMake = identifiers.some(text=>text.endsWith(`(${make})`))
    const provenCatalog = part.compatibility === 'confirmed' && !!part.evidenceUrl && part.supplier === 'reliable'
    // A product page alone is not model-fit evidence. Reuse the exact OEM/model
    // diagram proof only after Marcone independently identifies the same OEM/make.
    const compatibility = exactOEM && exactMake && provenCatalog ? 'confirmed' : exactOEM && provenCatalog ? 'requires_review' : 'not_verified'
    const evidenceUrl = provenCatalog ? part.evidenceUrl : ''
    const warehouse = Array.from(document.querySelectorAll('.branchstockqty')).map(e=>e.textContent?.trim()).filter(Boolean).join('; ').slice(0,200)
    return { ...part, id: `marcone:${part.partNumber}`, supplier: 'marcone', unitCostCents, quantity,
      imageUrl: exactOEM && exactMake ? part.imageUrl : undefined,
      availability: quantity !== null && quantity > 0 ? 'in_stock' : 'unknown', warehouse,
      productUrl: origin + path, evidenceUrl, evidenceSupplier: 'reliable', compatibility, retrievedAt: new Date().toISOString() }
  }
}
