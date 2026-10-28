export type CallLocation = { city: string | null; zip: string | null }

// Accept only explicitly labelled ZIPs or postal address syntax, never phone digits.
export function statedLocation(value: string): CallLocation {
  const zips = [...value.matchAll(/\b(?:zip(?:\s+code)?\s*[:=]?\s*|(?:IN|Indiana)\s*,?\s+)(\d{5})(?:-\d{4})?\b/gi)].map(match => match[1])
  const unique = [...new Set(zips)]
  const cities = [...value.matchAll(/(?:^|[,;\n])\s*([A-Za-z][A-Za-z .'-]{1,59}),\s*(?:IN|Indiana)\b/g)].map(match => match[1].trim())
  const labelled = /\bcity\s*:\s*([A-Za-z][A-Za-z .'-]{1,59}?)(?=\s+(?:zip|state)\b|[,;\n]|$)/i.exec(value)
  if (labelled) cities.push(labelled[1].trim())
  const reported = /\b(?:caller|customer)\s+(?:is\s+)?(?:from|lives in|located in)\s+([A-Za-z][A-Za-z '-]{1,59}?)(?=\s+\(?zip\b|[,;.\n]|$)/i.exec(value)
  if (reported) cities.push(reported[1].trim())
  const zipCity = /\bzip(?:\s+code)?\s*[:=]?\s*\d{5}(?:-\d{4})?\s+in\s+([A-Za-z][A-Za-z '-]{1,59}?)(?=\s+(?:is|was|has)\b|[,;.\n]|$)/i.exec(value)
  if (zipCity) cities.push(zipCity[1].trim())
  const normalized = [...new Set(cities.map(city => city.toLowerCase()))]
  return { zip: unique.length === 1 ? unique[0] : null, city: normalized.length === 1 ? normalized[0].replace(/\b[a-z]/g, letter => letter.toUpperCase()) : null }
}

export function callLocation(row: { location_city?: string | null; location_zip?: string | null; summary?: string | null; reason?: string | null; job_address?: string | null }): CallLocation {
  const fallback = statedLocation(row.job_address || [row.summary, row.reason].filter(Boolean).join('\n'))
  const sameZip = !row.location_zip || !fallback.zip || row.location_zip === fallback.zip
  return { city: row.location_city || (sameZip ? fallback.city : null), zip: row.location_zip || fallback.zip }
}

export function callLocationMap(location: CallLocation) {
  if (!location.zip) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.zip}, USA`)}`
}

export function summarizeCallLocations(locations: CallLocation[]) {
  const groups = new Map<string, { city: string; calls: number; zips: { zip: string; calls: number }[] }>()
  for (const location of locations) {
    const city = location.city || 'City not provided', key = city.toLowerCase()
    const group = groups.get(key) || { city, calls: 0, zips: [] }
    group.calls++
    const zip = location.zip || 'ZIP not provided'
    const count = group.zips.find(item => item.zip === zip)
    if (count) count.calls++
    else group.zips.push({ zip, calls: 1 })
    groups.set(key, group)
  }
  return { total: locations.length, unknown: locations.filter(location => !location.city && !location.zip).length,
    cities: [...groups.values()].map(group => ({ ...group, zips: group.zips.sort((a, b) => b.calls - a.calls || a.zip.localeCompare(b.zip)) })).sort((a, b) => b.calls - a.calls || a.city.localeCompare(b.city)) }
}
