import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { booleanValid } from '@turf/boolean-valid'
import { pointToLineDistance } from '@turf/point-to-line-distance'
import { lineString } from '@turf/helpers'
import { kinks } from '@turf/kinks'

export const northIndianapolisDefaults = {
  primaryZips: ['46240', '46250', '46260', '46268'],
  candidateZips: ['46220', '46236', '46256', '46278', '46280', '46290'],
}
export const approvedServiceZips = ['46032', '46033', '46037', '46038', '46040', '46052', '46055', '46060', '46062', '46069', '46074', '46075', '46077', '46220', '46236', '46240', '46250', '46256', '46260', '46268', '46278', '46280', '46290']
export type ZipCoverage = 'full' | 'partial' | 'manual'
export function zipCoverageStatus(settings: { zipCoverage?: Record<string, ZipCoverage> }, zip: string): ZipCoverage {
  return settings.zipCoverage?.[zip] ?? (/^462/.test(zip) ? 'partial' : ['46052', '46069', '46075'].includes(zip) ? 'manual' : 'full')
}
export type NorthIndianapolis = typeof northIndianapolisDefaults
export const indianapolisCandidateZips = [...northIndianapolisDefaults.primaryZips, ...northIndianapolisDefaults.candidateZips]
export function validateNorthIndianapolis(value: unknown): NorthIndianapolis | undefined {
  if (value === undefined) return undefined
  const p = value as NorthIndianapolis
  if (!p || Object.keys(p).some(k => !['primaryZips', 'candidateZips'].includes(k))
    || ![p.primaryZips, p.candidateZips].every(list => Array.isArray(list) && list.length <= 100 && list.every(zip => typeof zip === 'string' && /^462\d{2}$/.test(zip)))
    || p.primaryZips.some(zip => p.candidateZips.includes(zip))) throw Error('Invalid North Indianapolis ZIP groups')
  return { primaryZips: [...new Set(p.primaryZips)], candidateZips: [...new Set(p.candidateZips)] }
}
type AreaSettings = { serviceZips: string[]; zipOnlyZips?: string[]; zipCoverage?: Record<string, ZipCoverage>; northIndianapolis?: NorthIndianapolis; indianapolisBoundary?: AreaBoundary }
export function serviceZipDecision(settings: AreaSettings, zip: string) {
  if (!/^\d{5}$/.test(zip)) return { covered: false, reason: 'invalid_zip', nextAction: 'collectZip' as const }
  if (!settings.serviceZips.includes(zip)) return { covered: false, reason: 'outside_configured_zip_codes', nextAction: 'requestCallback' as const }
  if (settings.zipOnlyZips?.includes(zip)) return { covered: true, reason: 'owner_approved_zip', nextAction: 'checkServiceEligibility' as const }
  // Even primary ZIPs are only partially covered. Never approve from ZIP alone.
  return { covered: false, reason: 'full_address_required', nextAction: 'collectFullAddress' as const }
}
export type AreaBoundary = { type: 'Polygon'; coordinates: number[][][]; source: string; reviewNotes: string }
export type AreaLocation = { lat: number; lng: number; city?: string; precision?: string }
export function validateAreaBoundary(value: unknown): AreaBoundary | undefined {
  if (value === undefined || value === null) return undefined
  const p = value as AreaBoundary
  if (p.type !== 'Polygon' || !Array.isArray(p.coordinates) || p.coordinates.length !== 1
    || typeof p.source !== 'string' || !/^https:\/\//.test(p.source) || p.source.length > 500
    || typeof p.reviewNotes !== 'string' || !p.reviewNotes.trim() || p.reviewNotes.length > 2000
    || Object.keys(p).some(k => !['type', 'coordinates', 'source', 'reviewNotes'].includes(k))) throw Error('Invalid service boundary metadata')
  let count = 0
  for (const ring of p.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) throw Error('Invalid service boundary ring')
    for (const position of ring) {
      if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)
        || position[0] < -87 || position[0] > -85 || position[1] < 39 || position[1] > 41) throw Error('Boundary must use local WGS84 longitude/latitude coordinates')
      count++
    }
    if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw Error('Boundary rings must be closed')
  }
  if (count > 500 || !booleanValid(p) || kinks(p).features.length) throw Error('Invalid service boundary geometry')
  return { type: 'Polygon', coordinates: p.coordinates, source: p.source, reviewNotes: p.reviewNotes }
}
export async function boundaryFingerprint(boundary: AreaBoundary) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(validateAreaBoundary(boundary))))
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('')
}
export async function serviceAreaDecision(settings: AreaSettings, zip: string, location: AreaLocation, approvedHash = '') {
  const manual = (reason: string) => ({ covered: false, reason, nextAction: 'requestCallback' as const })
  const zipDecision = serviceZipDecision(settings, zip)
  if (zipDecision.nextAction !== 'collectFullAddress') return zipDecision
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng) || Math.abs(location.lat) > 90 || Math.abs(location.lng) > 180) return manual('invalid_geocoded_location')
  const coverage = zipCoverageStatus(settings, zip)
  if (coverage === 'manual') return manual('zip_requires_owner_review')
  const indianapolis = /^462\d{2}$/.test(zip) || /indianapolis/i.test(location.city || '')
  if (!indianapolis && coverage === 'partial') return manual('partial_coverage_boundary_requires_review')
  if (!indianapolis) return settings.serviceZips.includes(zip) ? { covered: true, reason: 'existing_approved_territory' } : manual('outside_approved_territory')
  const boundary = settings.indianapolisBoundary
  if (!boundary || !approvedHash || await boundaryFingerprint(boundary) !== approvedHash) return manual('boundary_pending_verification_and_owner_approval')
  if (location.precision !== 'ROOFTOP') return manual('address_precision_requires_review')
  const point = [location.lng, location.lat]
  // Review addresses on or near any edge of the owner-approved screenshot area.
  if (boundary.coordinates.some(ring => pointToLineDistance(point, lineString(ring), { units: 'meters' }) <= 30)) return manual('boundary_address_requires_review')
  return booleanPointInPolygon(point, boundary, { ignoreBoundary: true })
    ? { covered: true, reason: 'inside_approved_indianapolis_polygon' } : manual('outside_approved_boundary')
}
