export const receptionistTools = ['lookupCustomer', 'checkServiceArea', 'checkServiceEligibility', 'checkAvailability', 'createBooking', 'requestCallback', 'getBusinessPolicies', 'saveCallSummary'] as const
import { validateAreaBoundary, validateNorthIndianapolis, type AreaBoundary, type NorthIndianapolis, type ZipCoverage } from './receptionist-area'
export type ReceptionistTool = typeof receptionistTools[number]
export type ReceptionistSettings = {
  enabled: boolean
  testMode: boolean
  serviceZips: string[]
  zipOnlyZips?: string[]
  zipCoverage?: Record<string, ZipCoverage>
  indianapolisBoundary?: AreaBoundary
  northIndianapolis?: NorthIndianapolis
  appliances: string[]
  suspectedSealedSystemDiagnostic: boolean
  diagnosticFee: string
  transferPhone: string
  publicPhone: string
  revision: number
}
export const defaultReceptionistSettings: ReceptionistSettings = {
  enabled: false, testMode: true, serviceZips: [],
  appliances: ['Washer repair', 'Dryer repair', 'Dishwasher repair', 'Oven repair', 'Refrigerator repair'],
  suspectedSealedSystemDiagnostic: false, diagnosticFee: '', transferPhone: '', publicPhone: '', revision: 0,
}
export class ReceptionistError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReceptionistError('Expected an object')
  return value as Record<string, unknown>
}
export function textField(input: Record<string, unknown>, key: string, max = 200, optional = false) {
  const value = input[key]
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max || [...value].some(char => char.charCodeAt(0) <= 8)) throw new ReceptionistError(`Invalid ${key}`)
  return value.trim()
}
export function exactKeys(input: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new ReceptionistError('Unexpected field')
}
export function phoneNumber(value: string) {
  const digits = value.replace(/[\s().-]/g, '')
  const phone = /^\d{10}$/.test(digits) ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : digits
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)) throw new ReceptionistError('Valid US callback number required')
  return phone
}
export function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReceptionistError('Invalid date')
  const date = new Date(`${value}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ReceptionistError('Invalid date')
  return value
}
export function validateReceptionistSettings(value: unknown): ReceptionistSettings {
  const p = object(value)
  exactKeys(p, [...Object.keys(defaultReceptionistSettings), 'indianapolisBoundary', 'northIndianapolis', 'zipCoverage', 'zipOnlyZips'])
  let indianapolisBoundary: AreaBoundary | undefined
  let northIndianapolis: NorthIndianapolis | undefined
  try { northIndianapolis = validateNorthIndianapolis(p.northIndianapolis) }
  catch { throw new ReceptionistError('Invalid North Indianapolis ZIP groups') }
  try { indianapolisBoundary = validateAreaBoundary(p.indianapolisBoundary) }
  catch { throw new ReceptionistError('Invalid Indianapolis boundary geometry or review metadata') }
  for (const key of ['enabled', 'testMode', 'suspectedSealedSystemDiagnostic']) if (typeof p[key] !== 'boolean') throw new ReceptionistError(`Invalid ${key}`)
  if (!Array.isArray(p.serviceZips) || p.serviceZips.length > 250 || p.serviceZips.some(x => typeof x !== 'string' || !/^\d{5}$/.test(x))) throw new ReceptionistError('Invalid service ZIP codes')
  const zipCoverage = p.zipCoverage === undefined ? undefined : object(p.zipCoverage)
  if (p.zipOnlyZips !== undefined && (!Array.isArray(p.zipOnlyZips) || p.zipOnlyZips.some(zip => typeof zip !== 'string' || !(p.serviceZips as string[]).includes(zip)))) throw new ReceptionistError('Invalid ZIP-only service codes')
  if (zipCoverage && Object.entries(zipCoverage).some(([zip, status]) => !(p.serviceZips as string[]).includes(zip) || !['full', 'partial', 'manual'].includes(String(status)))) throw new ReceptionistError('Invalid ZIP coverage status')
  if (northIndianapolis && [...northIndianapolis.primaryZips, ...northIndianapolis.candidateZips].some(zip => !(p.serviceZips as string[]).includes(zip))) throw new ReceptionistError('North Indianapolis ZIP groups must be included in service ZIP codes')
  if (!Array.isArray(p.appliances) || !p.appliances.length || p.appliances.some(x => !defaultReceptionistSettings.appliances.includes(x))) throw new ReceptionistError('Invalid appliances')
  if (!Number.isSafeInteger(p.revision) || Number(p.revision) < 0) throw new ReceptionistError('Invalid revision')
  const transferPhone = textField(p, 'transferPhone', 20, true)
  const publicPhone = textField(p, 'publicPhone', 20, true)
  if (transferPhone) phoneNumber(transferPhone)
  if (publicPhone) phoneNumber(publicPhone)
  if (transferPhone && publicPhone && phoneNumber(transferPhone) === phoneNumber(publicPhone)) throw new ReceptionistError('Transfer destination must not be the public number')
  // Callback-only operation does not require a transfer destination.
  if (p.enabled && (!p.serviceZips.length || !publicPhone)) throw new ReceptionistError('Coverage and public phone required')
  return { ...(p.zipOnlyZips ? { zipOnlyZips: [...new Set(p.zipOnlyZips as string[])] } : {}), ...(zipCoverage ? { zipCoverage: zipCoverage as Record<string, ZipCoverage> } : {}), ...(northIndianapolis ? { northIndianapolis } : {}), ...(indianapolisBoundary ? { indianapolisBoundary } : {}), enabled: p.enabled as boolean, testMode: p.testMode as boolean, serviceZips: [...new Set(p.serviceZips as string[])], appliances: [...new Set(p.appliances as string[])],
    suspectedSealedSystemDiagnostic: p.suspectedSealedSystemDiagnostic as boolean, diagnosticFee: textField(p, 'diagnosticFee', 120, true), transferPhone, publicPhone, revision: Number(p.revision) }
}
export type ServiceRequest = { appliance: string; issue: string; diagnosis: 'unknown' | 'suspected_sealed_system' | 'confirmed_sealed_system'; requestedService: 'diagnostic' | 'repair' | 'refrigerant' | 'compressor' | 'sealed_system' }
export function serviceRequest(value: unknown): ServiceRequest {
  const p = object(value)
  exactKeys(p, ['appliance', 'issue', 'diagnosis', 'requestedService'])
  const appliance = textField(p, 'appliance', 60), issue = textField(p, 'issue', 1200)
  if (!['unknown', 'suspected_sealed_system', 'confirmed_sealed_system'].includes(String(p.diagnosis))) throw new ReceptionistError('Clarify diagnosis')
  if (!['diagnostic', 'repair', 'refrigerant', 'compressor', 'sealed_system'].includes(String(p.requestedService))) throw new ReceptionistError('Clarify requested service')
  return { appliance, issue, diagnosis: p.diagnosis as ServiceRequest['diagnosis'], requestedService: p.requestedService as ServiceRequest['requestedService'] }
}
export function serviceEligibility(settings: ReceptionistSettings, request: ServiceRequest) {
  const microwave = /microwave/i.test(request.appliance)
  if (microwave) {
    const description = `${request.appliance} ${request.issue}`
    if (/over[ -]the[ -]range|above (?:the )?(?:stove|range|cooktop)|countertop/i.test(description)) return { eligible: false, reason: 'unsupported_microwave_installation' }
    if (!/built[ -]in/i.test(description) || !/\b(?:combination|combo)\b/i.test(description) || !/\boven\b/i.test(description)) return { eligible: false, reason: 'clarify_microwave_installation' }
    if (!settings.appliances.includes('Oven repair')) return { eligible: false, reason: 'unsupported_appliance' }
  }
  if (!microwave && !settings.appliances.includes(request.appliance)) return { eligible: false, reason: 'unsupported_appliance' }
  if (request.diagnosis === 'confirmed_sealed_system' || ['refrigerant', 'compressor', 'sealed_system'].includes(request.requestedService)) return { eligible: false, reason: 'excluded_service' }
  const sealedWords = /freon|refrigerant|compressor|sealed.?system|gas\s+leak|filter[ -]?dr(?:y|i)er|condenser\s+coil|evaporator\s+coil|brazing|welding|фреон|компрессор/i.test(request.issue)
  if (sealedWords || request.diagnosis === 'suspected_sealed_system') {
    if (request.diagnosis !== 'suspected_sealed_system') return { eligible: false, reason: 'clarify_sealed_system_diagnosis' }
    if (!settings.suspectedSealedSystemDiagnostic || request.requestedService !== 'diagnostic') return { eligible: false, reason: 'diagnostic_not_authorized' }
  }
  return { eligible: true, reason: 'eligible' }
}
