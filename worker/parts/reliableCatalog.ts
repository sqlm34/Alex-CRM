import { normalizePart, shortText, type PartResult } from '../../shared/parts'
import type { SearchInput } from './connectors'

type Product = { productNumber: string; manufacturerCode: string; description: string; replacedPart?: string }
type CatalogResult = { status: 'SUCCESS' | 'MODEL_NOT_FOUND' | 'PART_NOT_FOUND'; results: PartResult[]; accountStatus: 'LOGIN_REQUIRED' }
const origin = 'https://reliableparts.net'

// These read-only endpoints were observed in the supplier's normal UI on 2026-10-07.
// Public catalog responses omit account prices and stock; never treat their false defaults as sold out.
export class ReliableCatalog {
  constructor(private request: typeof fetch = fetch) {}
  private async json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`SUPPLIER_HTTP_${response.status}`)
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('INVALID_RESPONSE')
    const raw = await response.text()
    if (raw.length > 3000000) throw new Error('INVALID_RESPONSE')
    return JSON.parse(raw)
  }
  async search(input: SearchInput, signal: AbortSignal): Promise<CatalogResult> {
    const model = shortText(input.identity.model)
    const brand = shortText(input.identity.brand)
    if (!model || !brand) throw new Error('Model and brand required')
    const data = await this.json(`/us-api/navapp/v1/model/number/${encodeURIComponent(model)}?manufacturer=${encodeURIComponent(brand)}`, signal) as { rpmodel?: { modelNumber: string; manufacturer: string; diagrams: { products: Product[] }[] } }
    const catalog = data?.rpmodel
    if (!catalog) return { status: 'MODEL_NOT_FOUND', results: [], accountStatus: 'LOGIN_REQUIRED' }
    if (catalog.modelNumber !== model || catalog.manufacturer.toLowerCase() !== brand.toLowerCase() || !Array.isArray(catalog.diagrams)) throw new Error('INVALID_RESPONSE')
    const terms = input.intent.searchTerms.map(term => shortText(term).toLowerCase().match(/[a-z0-9]+/g) || []).filter(words => words.length)
    const candidates = catalog.diagrams.flatMap(diagram => {
      if (!Array.isArray(diagram.products)) throw new Error('INVALID_RESPONSE')
      return diagram.products
    }).filter(product => {
      const words = new Set(shortText(product.description, 500).toLowerCase().match(/[a-z0-9]+/g) || [])
      return terms.some(term => term.every(word => words.has(word)))
    })
    const unique = [...new Map(candidates.map(part => [`${part.manufacturerCode}:${part.productNumber}`, part])).values()].slice(0, 20)
    const results: PartResult[] = []
    // Resolve separately so a replacement must reference its exact catalog candidate.
    for (const candidate of unique) {
      const partNumber = shortText(candidate.productNumber)
      const manufacturerCode = shortText(candidate.manufacturerCode)
      const products = await this.json('/us-api/navapp/v1/product/search', signal, { products: [{ productNumber: partNumber, manufacturerCode }] })
      if (!Array.isArray(products) || products.length > 10) throw new Error('INVALID_RESPONSE')
      for (const product of products as Product[]) {
        if (product.manufacturerCode !== manufacturerCode || (product.productNumber !== partNumber && product.replacedPart !== partNumber)) throw new Error('INVALID_RESPONSE')
        results.push(normalizePart({
          brand: catalog.manufacturer, model, partNumber: product.productNumber, description: product.description,
          unitCostCents: null, currency: 'USD', quantity: null, warehouse: '', availability: 'unknown',
          productUrl: `${origin}/us/content/#/part/${encodeURIComponent(manufacturerCode + '  ' + product.productNumber)}`,
          evidenceUrl: `${origin}/us/content/#/model/${encodeURIComponent(model)}/${encodeURIComponent(catalog.manufacturer)}`,
          compatibility: 'confirmed', replacedPartNumber: product.replacedPart || '', retrievedAt: new Date().toISOString(),
        }, 'reliable', model))
      }
    }
    return { status: results.length ? 'SUCCESS' : 'PART_NOT_FOUND', results: [...new Map(results.map(part => [part.id, part])).values()], accountStatus: 'LOGIN_REQUIRED' }
  }
}
