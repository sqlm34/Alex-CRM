import { normalizePart, shortText, type PartResult, type ModelLookup, type CatalogModel } from '../../shared/parts'
import type { SearchInput } from './connectors'

type Product = { productNumber: string; manufacturerCode: string; description: string; replacedPart?: string }
type CatalogResult = { status: 'SUCCESS' | 'MODEL_NOT_FOUND' | 'PART_NOT_FOUND'; results: PartResult[]; accountStatus: 'LOGIN_REQUIRED' }
const origin = 'https://reliableparts.net'

// These read-only endpoints were observed in the supplier's normal UI on 2026-10-07.
// Public catalog responses omit account prices and stock; never treat their false defaults as sold out.
export class ReliableCatalog {
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  async findModels(modelInput: string, brandInput: string, signal: AbortSignal): Promise<ModelLookup> {
    const model = shortText(modelInput).toUpperCase()
    const rawBrand = shortText(brandInput)
    const brand = ['Samsung', 'Kenmore', 'Maytag', 'Whirlpool', 'LG'].find(value => value.toLowerCase() === rawBrand.toLowerCase()) || rawBrand
    if (model.length < 4 || !brand) throw new Error('Enter a brand and at least four model characters')
    const key = (value: string) => value.toUpperCase().replace(/^(\d{3})\./, '$1')
    // Samsung catalog revision suffixes are suggestions only, never automatic substitutions.
    const family = brand === 'Samsung' ? model.replace(/-\d{2}$/, '') : model
    const models = new Map<string, CatalogModel>()
    const add = (number: unknown, manufacturer: unknown) => {
      if (typeof number !== 'string' || typeof manufacturer !== 'string') return
      const name = shortText(number); const make = shortText(manufacturer)
      if (make.toLowerCase() !== brand.toLowerCase() || !key(name).startsWith(key(family))) return
      models.set(name, { model: name, brand: make, diagramUrl: `${origin}/us/content/#/model/${encodeURIComponent(name)}/${encodeURIComponent(make)}` })
    }
    const exact = await this.json(`/us-api/navapp/v1/model/number/${encodeURIComponent(model)}?manufacturer=${encodeURIComponent(brand)}`, signal) as { rpmodel?: { modelNumber?: string; manufacturer?: string } } | null
    if (exact?.rpmodel && key(exact.rpmodel.modelNumber || '') === key(model)) add(exact.rpmodel.modelNumber, exact.rpmodel.manufacturer)
    const queries = [model]
    if (family !== model) queries.push(family)
    if (/^\d{3}\.?\d+$/.test(model)) queries.push(model.includes('.') ? model.replace('.', '') : `${model.slice(0, 3)}.${model.slice(3)}`)
    let truncated = false
    for (const query of queries) {
      const data = await this.json(`/us-api/navapp/v1/search/modelProduct?q=${encodeURIComponent(query)}&isCategoryNeeded=false`, signal) as { models?: { name?: string; manufacturer?: string }[]; modelsFound?: number } | null
      if (data?.models && !Array.isArray(data.models)) throw new Error('INVALID_RESPONSE')
      const found = data?.models || []
      if (found.length > 200) throw new Error('INVALID_RESPONSE')
      truncated ||= Number(data?.modelsFound) > found.length || found.length >= 20
      for (const item of found) add(item.name, item.manufacturer)
    }
    return { supplier: 'reliable', models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)), truncated }
  }
  private async json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'manual', signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.status === 204) return null
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
      const description = shortText(product.description, 500).toLowerCase()
      // Catalog accessories mention their parent component but are not that component.
      if (['fan_motor', 'air_damper'].includes(input.intent.canonicalPartType) && /^(clip|grommet|gasket|blade|shroud|bracket|screw|cover|seal)\b/.test(description)) return false
      const words = new Set(description.match(/[a-z0-9]+/g) || [])
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
