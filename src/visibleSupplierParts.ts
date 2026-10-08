import type { SupplierResponse } from '../shared/parts'

export function visibleSupplierParts(response: SupplierResponse) {
  return response.results.filter(part => !(
    response.supplier === 'reliable' &&
    response.suggestions?.some(suggestion => suggestion.productUrl === part.productUrl) &&
    part.unitCostCents === null && part.availability === 'unknown' && part.quantity === null
  ))
}
