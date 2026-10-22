// Preferred postal cities, not municipal boundaries or service eligibility.
// Sources: unitedstateszipcodes.org and zip-codes.com, reviewed 2026-10-18.
export const servicePostalCities: Record<string, string> = {
  '46032': 'Carmel', '46033': 'Carmel', '46037': 'Fishers', '46038': 'Fishers',
  '46040': 'Fortville', '46052': 'Lebanon', '46055': 'McCordsville',
  '46060': 'Noblesville', '46062': 'Noblesville', '46069': 'Sheridan',
  '46074': 'Westfield', '46075': 'Whitestown', '46077': 'Zionsville',
  '46220': 'Indianapolis', '46236': 'Indianapolis', '46240': 'Indianapolis',
  '46250': 'Indianapolis', '46256': 'Indianapolis', '46260': 'Indianapolis',
  '46268': 'Indianapolis', '46278': 'Indianapolis', '46280': 'Indianapolis',
  '46290': 'Indianapolis',
}

export function postalLocation(zip: string) {
  const city = Object.hasOwn(servicePostalCities, zip) ? servicePostalCities[zip] : undefined
  return city ? { city, state: 'IN', zip, source: 'postal_directory', geographicallyVerified: false } : null
}
