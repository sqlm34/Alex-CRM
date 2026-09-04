import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

test('drawer is mounted persistently and opens from the right side', () => {
  assert.match(appSource, /<aside className=\{`sidebar \$\{menuOpen \? 'open' : ''\}`\}/)
  assert.match(appSource, /aria-hidden=\{!menuOpen\}/)
  assert.doesNotMatch(appSource, /\{menuOpen \? \(\s*<>\s*<button className="menu-backdrop visible"/)
  assert.match(cssSource, /\.sidebar \{[\s\S]*left: auto;[\s\S]*right: 0;[\s\S]*transform: translateX\(104%\)/)
  assert.match(cssSource, /\.sidebar\.open \{[\s\S]*transform: translateX\(0\)/)
})

test('hamburger is the right-side topbar control on desktop and mobile', () => {
  const header = appSource.match(/<header className=\{`topbar[\s\S]*?<\/header>/)?.[0] || ''
  assert.ok(header.indexOf('Back') < header.indexOf('className="menu-trigger"'))
  assert.match(cssSource, /\.topbar \{[\s\S]*display: flex;[\s\S]*justify-content: space-between/)
  assert.match(cssSource, /@media \(max-width: 720px\)[\s\S]*\.topbar \{[\s\S]*flex-direction: row/)
})

test('New job and Time off moved from topbar into the drawer', () => {
  const header = appSource.match(/<header className=\{`topbar[\s\S]*?<\/header>/)?.[0] || ''
  const drawer = appSource.match(/<aside className=\{`sidebar[\s\S]*?<\/aside>/)?.[0] || ''
  assert.doesNotMatch(header, /New job|Time off/)
  assert.match(drawer, /onClick=\{openNewJob\}[\s\S]*New job/)
  assert.match(drawer, /onClick=\{openTimeOff\}[\s\S]*Time off/)
  assert.doesNotMatch(appSource, /const showNewJobButton/)
})

test('drawer navigation order starts with Search Schedule Jobs Clients actions', () => {
  const drawer = appSource.match(/<aside className=\{`sidebar[\s\S]*?<\/aside>/)?.[0] || ''
  const order = ['className="search-box"', 'Schedule', 'Jobs', 'Clients', 'New job', 'Time off', 'Payments', 'Settings', 'Log out']
  let previous = -1
  for (const label of order) {
    const next = drawer.indexOf(label)
    assert.ok(next > previous, `${label} should appear after the previous drawer item`)
    previous = next
  }
})

test('drawer actions close the menu before opening action screens', () => {
  assert.match(appSource, /const openNewJob = \(\) => \{[\s\S]*setMenuOpen\(false\)[\s\S]*setPage\('new'\)/)
  assert.match(appSource, /const openTimeOff = \(\) => \{[\s\S]*setMenuOpen\(false\)[\s\S]*setTimeOffOpen\(true\)/)
  assert.match(appSource, /const signOut = useCallback\(\(\) => \{[\s\S]*setMenuOpen\(false\)[\s\S]*setAuth\(null\)/)
})

test('brand colors and gradients match alex-repair.com tokens', () => {
  for (const token of ['#14325A', '#77B0E8', '#FFC700', '#2581D9', '#2c5181', '#163568', '#636060']) {
    assert.ok(cssSource.includes(token), `${token} should be present`)
  }
  assert.ok(cssSource.includes('linear-gradient(to right, #142f57, #113261, #0f346a, #0c3774, #0c397e)'))
  assert.ok(cssSource.includes('linear-gradient(90deg, rgba(119, 176, 232, 0.18) 0%, rgba(255, 199, 0, 0.14) 100%)'))
})

test('Unbounded font is applied across the app controls', () => {
  assert.match(cssSource, /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Unbounded/)
  assert.match(cssSource, /--alex-font: 'Unbounded', sans-serif/)
  assert.match(cssSource, /\.app-shell \{[\s\S]*font-family: var\(--alex-font\)/)
  assert.match(cssSource, /\.app-shell button,[\s\S]*\.app-shell select \{[\s\S]*font-family: var\(--alex-font\)/)
})

test('visible app dates include a year', () => {
  assert.match(appSource, /todayLabel[\s\S]*year: 'numeric'/)
  assert.match(appSource, /function formatScheduleMonth[\s\S]*month: 'short', year: 'numeric'/)
  assert.match(appSource, /function formatPaymentDate[\s\S]*year: 'numeric'/)
  assert.match(appSource, /formatOrdinalDay\(date\.getUTCDate\(\)\)}, \$\{date\.getUTCFullYear\(\)\}/)
})

test('Schedule startup Jobs history and swipe-back behavior remain wired', () => {
  assert.match(appSource, /const \[page, setPage\] = useState<Page>\('schedule'\)/)
  assert.match(appSource, /page === 'dashboard' \? \([\s\S]*<JobHistoryList/)
  assert.match(appSource, /page === 'schedule' \? \([\s\S]*<ScheduleTimeline/)
  assert.match(appSource, /const swipeBackEdgePx = 32/)
  assert.match(appSource, /deltaX >= swipeBackMinDeltaX[\s\S]*handleAppBack\(\)/)
})

test('booking page remains isolated from authenticated navigation changes', () => {
  assert.match(appSource, /if \(isBookingPage\) \{[\s\S]*<BookingPage/)
  assert.doesNotMatch(appSource, /BookingPage[\s\S]{0,1200}menu-trigger/)
})
