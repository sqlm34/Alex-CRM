export const itemPricingVersion = 'base-plus-5-percent-30c-v1'
export const serviceCallPricingVersion = 'service-call-base-v1'
export const maxSalePriceCents = 99_999_999
export const maxBasePriceCents = Math.floor(((maxSalePriceCents - 30) * 100 - 50) / 105)

export type ItemPricing = {
  label?: string
  baseUnitPriceCents?: number
  pricingVersion?: string
  unitPriceCents?: number
  amount?: number
}

export function pricingVersionForLabel(label = ''): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase() === 'service call'
    ? serviceCallPricingVersion : itemPricingVersion
}

export function isItemPricingVersion(version: unknown): boolean {
  return version === itemPricingVersion || version === serviceCallPricingVersion
}

export function salePriceFromBase(base: number, version = itemPricingVersion): number {
  if (!Number.isSafeInteger(base) || base < 0 || base > maxBasePriceCents) {
    throw new Error('Base price is outside the supported range')
  }
  if (version === serviceCallPricingVersion) return base
  // All operands remain safe integers; half cents round upwards.
  return Math.floor((base * 105 + 50) / 100) + 30
}

export function itemSalePrice(item: ItemPricing): number | undefined {
  return isItemPricingVersion(item.pricingVersion) && item.baseUnitPriceCents !== undefined
    ? salePriceFromBase(item.baseUnitPriceCents, item.pricingVersion)
    : item.unitPriceCents
}

// Run only at the write boundary, never when reading a historical invoice.
export function prepareItemPricing<T extends ItemPricing>(item: T, previous?: ItemPricing): T {
  if (item.baseUnitPriceCents !== undefined) {
    const base = item.baseUnitPriceCents
    // Existing prices keep their policy until the owner explicitly changes the base.
    const version = previous?.baseUnitPriceCents === base && isItemPricingVersion(previous.pricingVersion)
      ? previous.pricingVersion! : pricingVersionForLabel(item.label)
    return { ...item, baseUnitPriceCents: base, pricingVersion: version, unitPriceCents: salePriceFromBase(base, version) }
  }
  if (previous && isItemPricingVersion(previous.pricingVersion)) {
    // Old clients may omit private pricing fields. Preserve the stored basis.
    return { ...item, baseUnitPriceCents: previous.baseUnitPriceCents, pricingVersion: previous.pricingVersion,
      unitPriceCents: itemSalePrice(previous) }
  }
  // Untagged items include historical invoice fallback rows from legacy clients.
  // Only an explicit base-price write opts a row into the new pricing policy.
  return { ...item, pricingVersion: undefined }
}
