import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const envFiles = ['.env', '.env.local', '.env.production', '.env.production.local']
const googleMapsKeyName = 'VITE_GOOGLE_MAPS_API_KEY'
const googleMapsKeyPattern = /^AIza[0-9A-Za-z_-]{30,}$/
const isPullRequestCheck =
  process.env.CI === 'true' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GITHUB_EVENT_NAME === 'pull_request'

function parseEnvFile(filePath) {
  const values = {}
  const contents = readFileSync(filePath, 'utf8')

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const [, name, rawValue] = match
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }

  return values
}

function loadViteEnv() {
  const loaded = {}

  // Match the production env file order Vite uses for local builds.
  for (const file of envFiles) {
    const filePath = path.resolve(file)
    if (existsSync(filePath)) Object.assign(loaded, parseEnvFile(filePath))
  }

  return {
    ...loaded,
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('VITE_'))),
  }
}

function fail(message) {
  console.error(`Production env verification failed: ${message}`)
  process.exit(1)
}

const env = loadViteEnv()
const googleMapsKey = env[googleMapsKeyName]?.trim()

if (!googleMapsKey) {
  if (isPullRequestCheck) {
    console.log('Production env verification skipped: Google Maps key is local-only for PR checks.')
    process.exit(0)
  }

  fail(`${googleMapsKeyName} is required for production builds.`)
}

if (googleMapsKey === 'missing-key' || !googleMapsKeyPattern.test(googleMapsKey)) {
  fail(`${googleMapsKeyName} is present but does not look like a valid browser key.`)
}

console.log('Production env verification passed: Google Maps key is present.')
