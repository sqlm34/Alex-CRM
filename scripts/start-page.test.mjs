import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('authorized app starts on Schedule', () => {
  assert.match(appSource, /const \[page, setPage\] = useState<Page>\('schedule'\)/)
})

test('successful Login opens Schedule', () => {
  assert.match(appSource, /const handleAuthSuccess = useCallback\(\s*\(\s*session: AuthSession\s*\) => \{[\s\S]*?setAuth\(session\)[\s\S]*?setPage\('schedule'\)/)
})

test('Logout prepares the next Login to open Schedule', () => {
  assert.match(appSource, /const signOut = useCallback\(\(\) => \{[\s\S]*?setAuth\(null\)[\s\S]*?setPage\('schedule'\)/)
})

test('Jobs is not the startup page', () => {
  assert.doesNotMatch(appSource, /const \[page, setPage\] = useState<Page>\('dashboard'\)/)
  assert.doesNotMatch(appSource, /handleAuthSuccess[\s\S]{0,300}setPage\('dashboard'\)/)
})

test('manual navigation to Jobs still works', () => {
  assert.match(appSource, /onClick=\{\(\) => goToPage\('dashboard'\)\}[\s\S]*?Jobs/)
  assert.match(appSource, /page === 'dashboard' \? \([\s\S]*?<JobHistoryList/)
})

test('hamburger remains available', () => {
  assert.match(appSource, /className="menu-trigger"/)
  assert.match(appSource, /aria-label=\{menuOpen \? 'Close menu' : 'Open menu'\}/)
})

test('/booking remains separate from authenticated start page', () => {
  assert.match(appSource, /const isBookingPage = window\.location\.pathname\.replace\([^)]*\) === '\/booking'/)
  assert.match(appSource, /if \(isBookingPage\) \{[\s\S]*?<BookingPage/)
})
