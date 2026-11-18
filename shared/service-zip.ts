const spokenDigits: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }

export function normalizeServiceZip(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) return ''
  const text = value.trim().toLowerCase()
  const numeric = text.match(/^(\d{5})(?:\s*-\s*\d{4})?$/)
  if (numeric) return numeric[1]
  const tokens = text.split(/[\s,-]+/)
  const digits = tokens.map(token => spokenDigits[token] ?? (/^\d$/.test(token) ? token : ''))
  return tokens.length === 5 && digits.every(Boolean) ? digits.join('') : ''
}

export function deniedNewVisitZip(zip: unknown): boolean {
  return normalizeServiceZip(zip) === '46268'
}

export function newVisitAreaPolicy<T extends {
  serviceZips: string[]
  zipOnlyZips?: string[]
  zipCoverage?: Record<string, unknown>
  northIndianapolis?: { primaryZips: string[]; candidateZips: string[] }
}>(settings: T) {
  const allowed = (zip: string) => !deniedNewVisitZip(zip)
  return {
    serviceZips: settings.serviceZips.filter(allowed),
    zipOnlyZips: (settings.zipOnlyZips || []).filter(allowed),
    zipCoverage: Object.fromEntries(Object.entries(settings.zipCoverage || {}).filter(([zip]) => allowed(zip))),
    northIndianapolis: settings.northIndianapolis ? {
      primaryZips: settings.northIndianapolis.primaryZips.filter(allowed),
      candidateZips: settings.northIndianapolis.candidateZips.filter(allowed),
    } : null,
  }
}

// Public forms store the postal code in the full address, not a separate field.
export function deniedNewVisitAddress(address: string): boolean {
  const text = address.trim().replace(/[,\s]+(?:USA|US|United States)\.?$/i, '')
  const suffix = text.match(/(?:^|[,\s])(\d{5}(?:\s*-\s*\d{4})?)\s*$/)
  if (suffix && deniedNewVisitZip(suffix[1])) return true
  const spoken = text.match(/(?:^|[,\s])((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)[\s,-]+){4}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d))$/i)
  return !!spoken && deniedNewVisitZip(spoken[1])
}
