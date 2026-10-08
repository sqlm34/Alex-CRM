export const suppliers = ['reliable', 'marcone'] as const
export type Supplier = typeof suppliers[number]
export type SupplierStatus = 'CONNECTED' | 'CATALOG_ONLY' | 'LOGIN_REQUIRED' | 'NOT_CONFIGURED' | 'SUPPLIER_UNAVAILABLE' | 'SEARCH_TIMEOUT' | 'MODEL_NOT_FOUND' | 'PART_NOT_FOUND'
export type ApplianceIdentity = { brand: string; model: string; serial: string; applianceType: string; confidence: number; alternatives: string[] }
export type PartIntent = { canonicalPartType: string; searchTerms: string[]; literalTerm?: string }
export type CatalogModel = { model: string; brand: string; diagramUrl: string }
export type ModelLookup = { models: CatalogModel[]; supplier: 'reliable'; truncated: boolean }
export type PartResult = {
  id: string; supplier: Supplier; brand: string; model: string; partNumber: string; description: string
  unitCostCents: number | null; currency: 'USD'; availability: 'in_stock' | 'out_of_stock' | 'backorder' | 'unknown'
  quantity: number | null; warehouse: string; productUrl: string; evidenceUrl: string
  compatibility: 'confirmed' | 'requires_review' | 'not_verified'; evidenceSupplier?: Supplier; replacedPartNumber: string; retrievedAt: string
}
export type SupplierSuggestion = { partNumber: string; manufacturer: string; description: string; productUrl: string }
export type SupplierResponse = { supplier: Supplier; status: SupplierStatus; results: PartResult[]; authStatus?: string; suggestions?: SupplierSuggestion[] }
export type PartSearch = { id: string; identity: ApplianceIdentity; query: string; intent: PartIntent; suppliers: SupplierResponse[] }

export function shortText(value: unknown, max = 100): string {
  if (typeof value !== 'string' || value.length > max || [...value].some(char => char.charCodeAt(0) < 32)) throw new Error('Invalid text')
  return value.trim()
}
export function identityFrom(value: unknown): ApplianceIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid appliance identity')
  const v = value as Record<string, unknown>
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) throw new Error('Invalid confidence')
  if (!Array.isArray(v.alternatives) || v.alternatives.length > 8) throw new Error('Invalid model alternatives')
  return { brand: shortText(v.brand), model: shortText(v.model), serial: shortText(v.serial), applianceType: shortText(v.applianceType), confidence: v.confidence, alternatives: v.alternatives.map(x => shortText(x)) }
}
export function supplierUrl(value: unknown, supplier: Supplier): string {
  const url = new URL(shortText(value, 2000))
  const allowed = supplier === 'reliable' ? ['reliableparts.net'] : ['my.marcone.com']
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password || url.port) throw new Error('Invalid supplier URL')
  return url.href
}
export function isOemPartNumber(value: string): boolean {
  return /^(?=[A-Z0-9-]{4,40}$)(?=.*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(value.trim())
}
export function normalizePart(value: unknown, supplier: Supplier, model: string): PartResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid supplier result')
  const v = value as Record<string, unknown>
  const cents = v.unitCostCents
  if (cents !== null && (!Number.isSafeInteger(cents) || Number(cents) < 0 || Number(cents) > 100000000)) throw new Error('Invalid supplier price')
  if (v.currency !== 'USD') throw new Error('Unsupported supplier currency')
  const quantity = v.quantity
  if (quantity !== null && (!Number.isSafeInteger(quantity) || Number(quantity) < 0)) throw new Error('Invalid supplier quantity')
  const partNumber = shortText(v.partNumber)
  if (!partNumber) throw new Error('Missing OEM part number')
  const actualModel = shortText(v.model)
  const evidenceSupplier = v.evidenceSupplier === 'reliable' || v.evidenceSupplier === 'marcone' ? v.evidenceSupplier : supplier
  const evidenceUrl = v.evidenceUrl ? supplierUrl(v.evidenceUrl, evidenceSupplier) : ''
  const retrievedAt = shortText(v.retrievedAt)
  if (!Number.isFinite(Date.parse(retrievedAt)) || Date.parse(retrievedAt) > Date.now() + 60000) throw new Error('Invalid retrieval time')
  return {
    id: `${supplier}:${partNumber}`, supplier, brand: shortText(v.brand), model: actualModel, partNumber,
    description: shortText(v.description, 500), unitCostCents: cents as number | null, currency: 'USD',
    quantity: quantity as number | null, warehouse: shortText(v.warehouse, 200),
    availability: ['in_stock', 'out_of_stock', 'backorder'].includes(String(v.availability)) ? v.availability as PartResult['availability'] : 'unknown',
    productUrl: supplierUrl(v.productUrl, supplier), evidenceUrl,
    evidenceSupplier,
    compatibility: actualModel === model && evidenceUrl && (v.compatibility === 'confirmed' || v.compatibility === 'requires_review') ? v.compatibility : 'not_verified',
    replacedPartNumber: shortText(v.replacedPartNumber || ''), retrievedAt,
  }
}
