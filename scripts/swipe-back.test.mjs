import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

test('swipe 100 px right from the left edge invokes shared Back', () => {
  assert.match(appSource, /const swipeBackEdgePx = 32/)
  assert.match(appSource, /const swipeBackMinDeltaX = 80/)
  assert.match(appSource, /deltaX >= swipeBackMinDeltaX[\s\S]*handleAppBack\(\)/)
})

test('swipe started in the center is ignored', () => {
  assert.match(appSource, /event\.clientX > swipeBackEdgePx\) return/)
})

test('vertical scroll and slow gestures do not trigger Back', () => {
  assert.match(appSource, /const swipeBackMaxDeltaY = 50/)
  assert.match(appSource, /const swipeBackMaxMs = 800/)
  assert.match(appSource, /deltaY > swipeBackMaxDeltaY \|\| elapsed > swipeBackMaxMs/)
})

test('short swipe does not trigger Back', () => {
  assert.doesNotMatch(appSource, /deltaX >= (?:[0-7]?\d)\b/)
  assert.match(appSource, /deltaX >= swipeBackMinDeltaX/)
})

test('swipe inside input map tabs or overlays is ignored', () => {
  assert.match(appSource, /function isSwipeBackDisabledTarget/)
  for (const selector of [
    'input',
    'textarea',
    'select',
    'iframe',
    '.job-tabs',
    '.workiz-tabs',
    '.attachment-preview-backdrop',
    '.invoice-preview-backdrop',
    '.modal-backdrop',
    '[data-disable-swipe-back]',
  ]) {
    assert.ok(appSource.includes(selector), `${selector} should disable swipe-back`)
  }
})

test('open drawer is closed before page navigation', () => {
  assert.match(appSource, /if \(menuOpenRef\.current\) \{[\s\S]*setMenuOpen\(false\)[\s\S]*return true/)
})

test('job opened from Schedule returns to Schedule', () => {
  assert.match(appSource, /type ReturnPage = Extract<Page, 'dashboard' \| 'schedule' \| 'clients'>/)
  assert.match(appSource, /jobReturnPageRef = useRef<ReturnPage>\('schedule'\)/)
  assert.match(appSource, /currentPage === 'dashboard' \|\| currentPage === 'schedule'/)
})

test('job opened from Jobs returns to Jobs', () => {
  assert.match(appSource, /jobReturnPageRef\.current = resolveReturnPage\(jobReturnPageRef\.current\)/)
  assert.match(appSource, /setPage\(jobReturnPageRef\.current\)/)
})

test('swipe-back cannot double navigate', () => {
  assert.match(appSource, /start\.handled = true/)
  assert.match(appSource, /start\.handled \|\|/)
})

test('swipe listeners are removed on cleanup', () => {
  const addPointerListeners = appSource.match(/document\.addEventListener\('pointer/g) || []
  const removePointerListeners = appSource.match(/document\.removeEventListener\('pointer/g) || []
  assert.equal(addPointerListeners.length, 4)
  assert.equal(removePointerListeners.length, 4)
  assert.doesNotMatch(appSource, /document\.addEventListener\('touch/)
})

test('Android Back and screen Back button use the same function', () => {
  assert.match(appSource, /CapacitorApp\.addListener\('backButton'[\s\S]*handleAppBack\(\)/)
  assert.match(appSource, /className="back-button" type="button" onClick=\{handleAppBack\}/)
  assert.match(appSource, /onBack=\{handleAppBack\}/)
})

test('Jobs Schedule Auth Logout and feedback styling remain wired', () => {
  assert.match(appSource, /const \[page, setPage\] = useState<Page>\('schedule'\)/)
  assert.match(appSource, /setPage\('schedule'\)[\s\S]*showToast\(/)
  assert.match(appSource, /setAuth\(null\)[\s\S]*setPage\('schedule'\)/)
  assert.match(appSource, /page === 'dashboard'[\s\S]*<JobHistoryList/)
  assert.match(appSource, /page === 'schedule'[\s\S]*<ScheduleTimeline/)
  assert.match(cssSource, /--swipe-back-offset: 0px/)
  assert.match(cssSource, /transform: translateX\(var\(--swipe-back-offset\)\)/)
})
