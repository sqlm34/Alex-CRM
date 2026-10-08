export function searsModelSearchUrl(brand: string, model: string): string | null {
  let query = model.trim()
  if (query.length < 4 || query.length > 100 || !/^[a-z0-9 ./-]+$/i.test(query)) return null
  // Sears lists numeric Kenmore models without the separator after the maker prefix.
  // Keep every digit, including leading zeros and the full revision.
  if (/^kenmore$/i.test(brand.trim()) && /^\d{3}\.\d+$/.test(query)) query = query.replace('.', '')
  return `https://www.searspartsdirect.com/search?q=${encodeURIComponent(query)}&tab=model`
}
