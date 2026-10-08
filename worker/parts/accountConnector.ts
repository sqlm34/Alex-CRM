import type { SupplierResponse } from '../../shared/parts'
import { ReliablePublicConnector, type SearchInput, type SupplierConnector } from './connectors'
import { ReliableAccount } from './reliableAccount'
import { MarconeAccount } from './marconeAccount'
import { ReliableCatalog } from './reliableCatalog'
import { supplierSession, SupplierAuthError, type SupplierSecrets } from './supplierAuth'
import type { PartsSql } from './storage'

export class ReliableAccountConnector extends ReliablePublicConnector {
  constructor(private sql: PartsSql, private secrets: SupplierSecrets, catalog = new ReliableCatalog()) { super(catalog) }
  async searchByModel(input: SearchInput): Promise<SupplierResponse> {
    const catalog = await super.searchByModel(input)
    if (!catalog.results.length && !catalog.suggestions?.length) return catalog
    try {
      const adapter = new ReliableAccount()
      const { session, status } = await supplierSession(this.sql, this.secrets, adapter)
      const signal = AbortSignal.timeout(25000)
      const suggestions = catalog.suggestions?.length ? await adapter.priceSuggestions(catalog.suggestions, session, signal) : catalog.suggestions
      const results = []
      for (const part of catalog.results) results.push(await adapter.quote(part, session, signal))
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: 'reliable', status, method: 'authenticated_http' }))
      return { ...catalog, suggestions, status: results.some(p => p.unitCostCents !== null) || suggestions?.some(p => p.unitCostCents != null) ? 'CONNECTED' : 'CATALOG_ONLY', results, authStatus: status }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && /^[A-Z0-9]{5}$/.test(String(error.code)) ? String(error.code) : undefined
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: 'reliable', status: error instanceof SupplierAuthError ? error.status : 'LOGIN_FAILED', code }))
      return { ...catalog, authStatus: error instanceof SupplierAuthError ? error.status : 'LOGIN_FAILED' }
    }
  }
}

export class MarconeAccountConnector implements SupplierConnector {
  readonly supplier = 'marcone' as const
  constructor(private sql: PartsSql, private secrets: SupplierSecrets, private catalog = new ReliableCatalog()) {}
  async checkSession() { return 'CATALOG_ONLY' as const }
  async searchByModel(input: SearchInput): Promise<SupplierResponse> {
    try {
      const adapter = new MarconeAccount()
      const { session, status } = await supplierSession(this.sql, this.secrets, adapter)
      const signal = AbortSignal.timeout(25000)
      if (input.intent?.canonicalPartType === 'oem_part_number') {
        return { ...await adapter.searchParts(input.intent.searchTerms[0], session, signal), authStatus: status }
      }
      const catalog = await this.catalog.search(input, signal)
      if (catalog.status !== 'SUCCESS') return { supplier: this.supplier, status: catalog.status, results: [], authStatus: status }
      const results = []
      for (const part of catalog.results) results.push(await adapter.quote(part, session, signal))
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: this.supplier, status, method: 'authenticated_http' }))
      return { supplier: this.supplier, status: results.length ? 'CONNECTED' : 'PART_NOT_FOUND', results, authStatus: status }
    } catch (error) {
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: this.supplier, status: error instanceof SupplierAuthError ? error.status : 'LOGIN_FAILED' }))
      return { supplier: this.supplier, status: error instanceof SupplierAuthError ? 'LOGIN_REQUIRED' : error instanceof Error && error.name === 'TimeoutError' ? 'SEARCH_TIMEOUT' : 'SUPPLIER_UNAVAILABLE', results: [], ...(error instanceof SupplierAuthError ? {authStatus:error.status} : {}) }
    }
  }
  async searchByPartNumber(): Promise<SupplierResponse> { return {supplier:this.supplier,status:'LOGIN_REQUIRED',results:[]} }
  async getPartDetails(): Promise<SupplierResponse> { return {supplier:this.supplier,status:'LOGIN_REQUIRED',results:[]} }
}
