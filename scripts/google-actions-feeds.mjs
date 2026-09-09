import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MERCHANT_WEBSITE = 'https://www.alex-repair.com'
export const BOOKING_ACTION_URL = 'https://aleksappliancerepair.com/booking'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (field) => { throw new Error(`Invalid or unconfirmed ${field}`) }
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /TODO|PLACEHOLDER|REPLACE_ME|[<>\x00-\x1f]/i.test(value)) fail(field)
  return value
}
const id = (value, field) => {
  text(value, field)
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(field)
}
const keys = (value, allowed, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(field)
}

export function validateConfig(config) {
  keys(config, ['environment', 'googlePartnerId', 'googleFeedVersionConfirmed', 'ownerDataConfirmed', 'merchantWebsite', 'bookingActionUrl', 'locale', 'merchants'], 'config')
  if (config.environment !== 'sandbox') fail('environment (sandbox only)')
  text(config.googlePartnerId, 'googlePartnerId')
  if (!/^\d+$/.test(config.googlePartnerId) || /^0+$/.test(config.googlePartnerId)) fail('googlePartnerId')
  if (config.googleFeedVersionConfirmed !== true || config.ownerDataConfirmed !== true) fail('Google/owner confirmations')
  if (config.merchantWebsite !== MERCHANT_WEBSITE) fail('merchantWebsite')
  if (config.bookingActionUrl !== BOOKING_ACTION_URL) fail('bookingActionUrl')
  text(config.locale, 'locale')
  try { if (Intl.getCanonicalLocales(config.locale)[0] !== config.locale) fail('locale') } catch { fail('locale') }
  if (!Array.isArray(config.merchants) || !config.merchants.length) fail('merchants')
  if (config.merchants.length !== 1) fail('merchants (runtime currently supports one configured merchant)')
  const merchantIds = new Set()
  const linkIds = new Set()
  for (const merchant of config.merchants) {
    keys(merchant, ['entityId', 'linkId', 'name', 'telephone', 'address', 'services'], 'merchant')
    id(merchant.entityId, 'entityId')
    id(merchant.linkId, 'linkId')
    if (merchantIds.has(merchant.entityId) || linkIds.has(merchant.linkId)) fail('duplicate merchant/link ID')
    merchantIds.add(merchant.entityId)
    linkIds.add(merchant.linkId)
    text(merchant.name, 'merchant.name')
    if (!/^\+[1-9]\d{7,14}$/.test(merchant.telephone)) fail('telephone (E.164)')
    keys(merchant.address, ['country', 'locality', 'region', 'postal_code', 'street_address'], 'address')
    for (const field of ['country', 'locality', 'region', 'postal_code', 'street_address']) text(merchant.address[field], `address.${field}`)
    if (merchant.address.country !== 'US') fail('country (US-only initial integration)')
    if (!/^[A-Z]{2}$/.test(merchant.address.region) || !/^\d{5}(-\d{4})?$/.test(merchant.address.postal_code)) fail('US region/postal code')
    if (!Array.isArray(merchant.services) || !merchant.services.length) fail('services')
    const serviceIds = new Set()
    for (const service of merchant.services) {
      keys(service, ['serviceId', 'name', 'category', 'description', 'actionUrl', 'landingPageVerified', 'priceInterpretation', 'durationInterpretation'], 'service')
      id(service.serviceId, 'serviceId')
      if (serviceIds.has(service.serviceId)) fail('duplicate serviceId')
      serviceIds.add(service.serviceId)
      text(service.name, 'service.name')
      text(service.category, 'service.category')
      if (service.description !== undefined) text(service.description, 'service.description')
      text(service.actionUrl, 'service.actionUrl')
      let url
      try { url = new URL(service.actionUrl) } catch { fail('service.actionUrl') }
      if (url.origin + url.pathname !== BOOKING_ACTION_URL || url.username || url.password || url.hash || url.searchParams.has('rwg_token')) fail('service.actionUrl')
      if (service.landingPageVerified !== true) fail('service.landingPageVerified')
      if (service.priceInterpretation !== 'INTERPRETATION_NOT_DISPLAYED' || service.durationInterpretation !== 'INTERPRETATION_NOT_DISPLAYED') fail('price/duration (only undisplayed supported)')
    }
  }
  return config
}

export function generateFeeds(config, generationTimestamp) {
  validateConfig(config)
  if (!Number.isSafeInteger(generationTimestamp) || generationTimestamp <= 0 || generationTimestamp > 253402300799) fail('generationTimestamp (Unix seconds)')
  const localized = value => ({ value, localized_value: [{ locale: config.locale, value }] })
  const entities = [], actions = [], services = []
  for (const m of config.merchants) {
    entities.push({ entity_id: m.entityId, name: m.name, telephone: m.telephone, url: config.merchantWebsite, location: { address: { country: m.address.country, locality: m.address.locality, region: m.address.region, postal_code: m.address.postal_code, street_address: m.address.street_address } } })
    actions.push({ entity_id: m.entityId, link_id: m.linkId, url: config.bookingActionUrl, actions: [{ appointment_info: {} }] })
    for (const s of m.services) services.push({ merchant_id: m.entityId, service_id: s.serviceId, localized_service_name: localized(s.name), localized_service_category: localized(s.category), ...(s.description === undefined ? {} : { localized_service_description: localized(s.description) }), service_price: { price_interpretation: s.priceInterpretation }, action_link: [{ url: s.actionUrl }], service_duration: { duration_interpretation: s.durationInterpretation } })
  }
  const files = {}
  for (const [name, data] of [['reservewithgoogle.entity', entities], ['reservewithgoogle.action.v2', actions], ['glam.service.v0', services]]) {
    const filename = `${name}-${generationTimestamp}_0001.json`
    files[filename] = JSON.stringify({ data }, null, 2) + '\n'
    files[`${name}-${generationTimestamp}.filesetdesc.json`] = JSON.stringify({ generation_timestamp: generationTimestamp, name, data_file: [filename] }, null, 2) + '\n'
  }
  return files
}

export async function writeFeeds(config, generationTimestamp, outputDirectory) {
  const files = generateFeeds(config, generationTimestamp)
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) fail('out (absolute new directory required)')
  const parent = await realpath(dirname(resolve(outputDirectory)))
  const root = await realpath(repoRoot)
  const rel = relative(root, parent)
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) fail('out (must be outside repository)')
  const target = resolve(parent, resolve(outputDirectory).split(sep).at(-1))
  // Exclusive directory creation prevents overwrites and rejects existing symlinks.
  await mkdir(target)
  for (const [name, content] of Object.entries(files)) await writeFile(resolve(target, name), content, { flag: 'wx', mode: 0o600 })
  return { outputDirectory: target, files: Object.keys(files) }
}

export async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--config', '--out', '--timestamp'].includes(key) || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('CLI arguments: --config PATH --out ABSOLUTE_NEW_DIR --timestamp UNIX_SECONDS')
    options[key] = args[i + 1]
  }
  if (Object.keys(options).length !== 3 || !/^\d+$/.test(options['--timestamp'])) fail('CLI arguments: --config PATH --out ABSOLUTE_NEW_DIR --timestamp UNIX_SECONDS')
  const config = JSON.parse(await readFile(options['--config'], 'utf8'))
  return writeFeeds(config, Number(options['--timestamp']), options['--out'])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(`Generated ${result.files.length} offline sandbox files in ${result.outputDirectory}. Nothing uploaded.`)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
