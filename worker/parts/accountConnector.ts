import type { SupplierResponse } from '../../shared/parts'
import { ReliablePublicConnector, type SearchInput } from './connectors'
import { ReliableAccount } from './reliableAccount'
import { supplierSession, SupplierAuthError, type SupplierSecrets } from './supplierAuth'
import type { PartsSql } from './storage'

export class ReliableAccountConnector extends ReliablePublicConnector {
  constructor(private sql: PartsSql, private secrets: SupplierSecrets) { super() }
  async searchByModel(input: SearchInput): Promise<SupplierResponse> {
    const catalog = await super.searchByModel(input)
    if (!catalog.results.length) return catalog
    try {
      const adapter = new ReliableAccount()
      const { session, status } = await supplierSession(this.sql, this.secrets, adapter)
      const signal = AbortSignal.timeout(25000)
      const results = []
      for (const part of catalog.results) results.push(await adapter.quote(part, session, signal))
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: 'reliable', status, method: 'authenticated_http' }))
      return { ...catalog, status: results.some(p => p.unitCostCents !== null) ? 'CONNECTED' : 'CATALOG_ONLY', results }
    } catch (error) {
      console.log(JSON.stringify({ event: 'supplier_auth', supplier: 'reliable', status: error instanceof SupplierAuthError ? error.status : 'LOGIN_FAILED' }))
      return catalog
    }
  }
}
