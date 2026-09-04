import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const envVerifier = path.join(repoRoot, 'scripts', 'verify-production-env.mjs')
const bundleVerifier = path.join(repoRoot, 'scripts', 'verify-production-bundle.mjs')

function makeTempDir() {
  return path.join(tmpdir(), `alex-maps-key-${process.pid}-${Math.random().toString(16).slice(2)}`)
}

function runNode(scriptPath, cwd, extraEnv = {}) {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !['VITE_GOOGLE_MAPS_API_KEY', 'CI', 'GITHUB_ACTIONS', 'GITHUB_EVENT_NAME'].includes(name),
    ),
  )

  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: { ...cleanEnv, ...extraEnv },
  })
}

test('production build verifies Google Maps key before Vite bundles client code', () => {
  assert.match(packageJson.scripts.build, /node scripts\/verify-production-env\.mjs && tsc -b && vite build/)
})

test('app no longer embeds the missing-key placeholder fallback', () => {
  assert.doesNotMatch(appSource, /missing-key/)
  assert.match(appSource, /googleMapsApiKey: googleMapsKey \?\? ''/)
})

test('production env verification fails without printing a key value', () => {
  const cwd = makeTempDir()
  mkdirSync(cwd)
  try {
    const result = runNode(envVerifier, cwd)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /VITE_GOOGLE_MAPS_API_KEY is required/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /AIza[0-9A-Za-z_-]{30,}/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production env verification allows local-only key absence for GitHub PR checks', () => {
  const cwd = makeTempDir()
  mkdirSync(cwd)
  try {
    const result = runNode(envVerifier, cwd, {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /local-only for PR checks/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /AIza[0-9A-Za-z_-]{30,}/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production env verification accepts a local Vite env key without printing it', () => {
  const cwd = makeTempDir()
  const fakeKey = `AIza${'A'.repeat(35)}`
  mkdirSync(cwd)
  writeFileSync(path.join(cwd, '.env.production.local'), `VITE_GOOGLE_MAPS_API_KEY=${fakeKey}\n`)
  try {
    const result = runNode(envVerifier, cwd)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Google Maps key is present/)
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(fakeKey), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production bundle verification rejects missing-key placeholders', () => {
  const cwd = makeTempDir()
  mkdirSync(path.join(cwd, 'dist', 'assets'), { recursive: true })
  writeFileSync(path.join(cwd, 'dist', 'index.html'), '<script type="module" src="/assets/index-test.js"></script>')
  writeFileSync(
    path.join(cwd, 'dist', 'assets', 'index-test.js'),
    "const a='https://alex-crm-api.alexeasyrepair.workers.dev'; const b='/api/jobs'; const c='/api/auth/login'; const d='missing-key';",
  )
  try {
    const result = runNode(bundleVerifier, cwd)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /placeholder key/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('production bundle verification requires a Google Maps browser key', () => {
  const cwd = makeTempDir()
  mkdirSync(path.join(cwd, 'dist', 'assets'), { recursive: true })
  writeFileSync(path.join(cwd, 'dist', 'index.html'), '<script type="module" src="/assets/index-test.js"></script>')
  writeFileSync(
    path.join(cwd, 'dist', 'assets', 'index-test.js'),
    "const a='https://alex-crm-api.alexeasyrepair.workers.dev'; const b='/api/jobs'; const c='/api/auth/login';",
  )
  try {
    const result = runNode(bundleVerifier, cwd)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Google Maps browser key/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
