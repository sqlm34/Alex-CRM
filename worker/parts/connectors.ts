import { normalizePart, suppliers, type ApplianceIdentity, type PartIntent, type Supplier, type SupplierResponse, type SupplierStatus } from '../../shared/parts'

export type SearchInput = { identity: ApplianceIdentity; intent: PartIntent }
export interface SupplierConnector {
  supplier: Supplier
  checkSession(): Promise<SupplierStatus>
  searchByModel(input: SearchInput): Promise<SupplierResponse>
  searchByPartNumber(partNumber: string, model: string): Promise<SupplierResponse>
  getPartDetails(partNumber: string, model: string): Promise<SupplierResponse>
}
// A private service binding, not a supplier API. No user-supplied URL or credentials cross this boundary.
export type PartsService = { fetch(request: Request): Promise<Response> }
class ServiceConnector implements SupplierConnector {
  constructor(public supplier: Supplier, private service?: PartsService) {}
  private async call(action: string, input: unknown, model = ''): Promise<SupplierResponse> {
    if (!this.service) return { supplier: this.supplier, status: 'NOT_CONFIGURED', results: [] }
    const response = await this.service.fetch(new Request(`https://parts-service.internal/${this.supplier}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000),
    }))
    if (!response.ok) return { supplier: this.supplier, status: response.status === 401 ? 'LOGIN_REQUIRED' : 'SUPPLIER_UNAVAILABLE', results: [] }
    const raw = await response.text()
    if (raw.length > 200000) throw new Error('Invalid supplier response')
    const data = JSON.parse(raw)
    const statuses: SupplierStatus[] = ['CONNECTED', 'LOGIN_REQUIRED', 'NOT_CONFIGURED', 'SUPPLIER_UNAVAILABLE', 'SEARCH_TIMEOUT', 'MODEL_NOT_FOUND', 'PART_NOT_FOUND']
    if (!statuses.includes(data.status) || !Array.isArray(data.results) || data.results.length > 50) throw new Error('Invalid supplier response')
    return { supplier: this.supplier, status: data.status, results: data.status === 'CONNECTED' ? data.results.map((v: unknown) => normalizePart(v, this.supplier, model)) : [] }
  }
  async checkSession() { return (await this.call('session', {})).status }
  searchByModel(input: SearchInput) { return this.call('search-model', input, input.identity.model) }
  searchByPartNumber(partNumber: string, model: string) { return this.call('search-part', { partNumber, model }, model) }
  getPartDetails(partNumber: string, model: string) { return this.call('part-details', { partNumber, model }, model) }
}
export class ReliablePartsConnector extends ServiceConnector { constructor(service?: PartsService) { super('reliable', service) } }
export class MarconeConnector extends ServiceConnector { constructor(service?: PartsService) { super('marcone', service) } }
export async function connectionStatuses(connectors: SupplierConnector[]): Promise<SupplierResponse[]> {
  return Promise.all(connectors.map(async connector => {
    try { return { supplier: connector.supplier, status: await connector.checkSession(), results: [] } }
    catch { return { supplier: connector.supplier, status: 'SUPPLIER_UNAVAILABLE', results: [] } }
  }))
}
export async function searchSuppliers(input: SearchInput, connectors: SupplierConnector[]): Promise<SupplierResponse[]> {
  const settled = await Promise.allSettled(connectors.map(async connector => {
    const status = await connector.checkSession()
    return status === 'CONNECTED' ? connector.searchByModel(input) : { supplier: connector.supplier, status, results: [] }
  }))
  return settled.map((result, index) => result.status === 'fulfilled' ? result.value : {
    supplier: connectors[index]?.supplier || suppliers[index], status: result.reason?.name === 'TimeoutError' ? 'SEARCH_TIMEOUT' : 'SUPPLIER_UNAVAILABLE', results: [],
  })
}
