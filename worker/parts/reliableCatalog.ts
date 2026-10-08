import { normalizePart, shortText, type PartResult, type ModelLookup, type CatalogModel } from '../../shared/parts'
import type { SearchInput } from './connectors'

type Product = { productNumber: string; manufacturerCode: string; description: string; replacedPart?: string }
type CatalogResult = { status: 'SUCCESS' | 'MODEL_NOT_FOUND' | 'PART_NOT_FOUND'; results: PartResult[]; accountStatus: 'LOGIN_REQUIRED' }
const origin = 'https://reliableparts.net'

// These read-only endpoints were observed in the supplier's normal UI on 2026-10-07.
// Public catalog responses omit account prices and stock; never treat their false defaults as sold out.
export class ReliableCatalog {
  private searches = new Map<string, Promise<CatalogResult>>()
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
  search(input: SearchInput, signal: AbortSignal): Promise<CatalogResult> {
    const key = JSON.stringify(input)
    let pending = this.searches.get(key)
    if (!pending) { pending = this.searchCatalog(input, signal); this.searches.set(key, pending) }
    return pending
  }
  private async searchCatalog(input: SearchInput, signal: AbortSignal): Promise<CatalogResult> {
    const model = shortText(input.identity.model)
    const brand = shortText(input.identity.brand)
    if (!model || !brand) throw new Error('Model and brand required')
    const data = await this.json(`/us-api/navapp/v1/model/number/${encodeURIComponent(model)}?manufacturer=${encodeURIComponent(brand)}`, signal) as { rpmodel?: { modelNumber: string; manufacturer: string; diagrams: { diagramName?: string; products: Product[] }[] } }
    const catalog = data?.rpmodel
    if (!catalog) return { status: 'MODEL_NOT_FOUND', results: [], accountStatus: 'LOGIN_REQUIRED' }
    if (catalog.modelNumber !== model || catalog.manufacturer.toLowerCase() !== brand.toLowerCase() || !Array.isArray(catalog.diagrams)) throw new Error('INVALID_RESPONSE')
    const terms = input.intent.searchTerms.map(term => shortText(term).toLowerCase().match(/[a-z0-9]+/g) || []).filter(words => words.length)
    const resolved = new Map<string, Product[]>()
    const productKey = (p: Product) => `${p.manufacturerCode}:${p.productNumber}`
    const resolve = async (candidate: Product): Promise<Product[]> => {
      const cached = resolved.get(productKey(candidate))
      if (cached) return cached
      const products = await this.json('/us-api/navapp/v1/product/search', signal, { products: [{ productNumber: shortText(candidate.productNumber), manufacturerCode: shortText(candidate.manufacturerCode) }] })
      if (!Array.isArray(products) || products.length > 10) throw new Error('INVALID_RESPONSE')
      for (const product of products as Product[]) {
        // Reliable explicitly returns Whirlpool replacements for Maytag catalog numbers.
        const sameMake = product.manufacturerCode === candidate.manufacturerCode || (candidate.manufacturerCode === 'MAY' && product.manufacturerCode === 'WPL')
        if (!sameMake || (product.productNumber !== candidate.productNumber && product.replacedPart !== candidate.productNumber)) throw new Error('INVALID_RESPONSE')
      }
      resolved.set(productKey(candidate), products)
      return products
    }
    const productsInModel = catalog.diagrams.flatMap(diagram => {
      if (!Array.isArray(diagram.products)) throw new Error('INVALID_RESPONSE')
      return diagram.products
    })
    const literalWords = input.intent.literalTerm?.toLowerCase().match(/[a-z]+/g) || []
    const lookupWords = new Set((literalWords.length ? literalWords : terms.flat()).filter(word => !['and','the','of','for','with','part','parts','assembly','unit'].includes(word)))
    const preferred = new Set(catalog.diagrams.filter(d => (d.diagramName?.toLowerCase().match(/[a-z]+/g) || []).some(word => lookupWords.has(word))).flatMap(d => d.products).map(productKey))
    const missing = [...new Map(productsInModel.filter(p => !p.description?.trim()).map(p => [productKey(p), p])).values()]
    let incomplete = false
    const hydrate = async (items: Product[]) => {
      let next = 0
      await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next++]
          try { await resolve(item) } catch (error) {
            if (error instanceof Error && error.message === 'SUPPLIER_HTTP_404') { incomplete = true; continue }
            throw error
          }
        }
      }))
    }
    const descriptions = (p: Product) => p.description?.trim() ? [p.description] : (resolved.get(productKey(p)) || []).map(x => x.description)
    const matches = (p: Product, phrases: string[][]) => descriptions(p).some(description => {
      const words = new Set(shortText(description, 500).toLowerCase().match(/[a-z0-9]+/g) || [])
      return phrases.some(phrase => phrase.length && phrase.every(word => words.has(word)))
    })
    await hydrate(missing.filter(p => preferred.has(productKey(p))))
    if (!productsInModel.some(p => matches(p, literalWords.length ? [literalWords] : terms))) {
      await hydrate(missing.filter(p => !preferred.has(productKey(p))))
    }
    const literalMatches = literalWords.length ? productsInModel.filter(product => {
      return matches(product, [literalWords])
    }) : []
    // A technician's catalog wording takes precedence over AI synonyms when it matches.
    const candidates = literalMatches.length ? literalMatches : productsInModel.filter(product => {
      const description = descriptions(product).join(' ').toLowerCase()
      // Catalog accessories mention their parent component but are not that component.
      if (['fan_motor', 'air_damper'].includes(input.intent.canonicalPartType) && /^(clip|grommet|gasket|blade|shroud|bracket|screw|cover|seal)\b/.test(description)) return false
      const words = new Set(description.match(/[a-z0-9]+/g) || [])
      return terms.some(term => term.every(word => words.has(word)))
    })
    const unique = [...new Map(candidates.map(part => [`${part.manufacturerCode}:${part.productNumber}`, part])).values()].slice(0, 20)
    const results: PartResult[] = []
    // Resolve separately so a replacement must reference its exact catalog candidate.
    for (const candidate of unique) {
      const products = await resolve(candidate)
      for (const product of products as Product[]) {
        results.push(normalizePart({
          brand: catalog.manufacturer, model, partNumber: product.productNumber, description: product.description,
          unitCostCents: null, currency: 'USD', quantity: null, warehouse: '', availability: 'unknown',
          productUrl: `${origin}/us/content/#/part/${encodeURIComponent(product.manufacturerCode + '  ' + product.productNumber)}`,
          evidenceUrl: `${origin}/us/content/#/model/${encodeURIComponent(model)}/${encodeURIComponent(catalog.manufacturer)}`,
          compatibility: 'confirmed', replacedPartNumber: product.replacedPart || '', retrievedAt: new Date().toISOString(),
        }, 'reliable', model))
      }
    }
    if (!results.length && incomplete) throw new Error('SUPPLIER_HTTP_404')
    return { status: results.length ? 'SUCCESS' : 'PART_NOT_FOUND', results: [...new Map(results.map(part => [part.id, part])).values()], accountStatus: 'LOGIN_REQUIRED' }
  }
}
