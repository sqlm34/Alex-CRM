import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
const splash = read('src/StartupSplash.tsx')
const css = read('src/StartupSplash.css')
test('startup is Android-only and excludes public booking', () => {
  assert.match(splash, /Capacitor.getPlatform\(\) === 'android'/)
  assert.match(splash, /!window.location.pathname.startsWith\('\/booking'\)/)
  assert.doesNotMatch(splash, /fetch\(|localStorage|sessionStorage|setInterval|PaymentIntent/)
})
test('CRM mounts underneath immediately and splash leaves at ten seconds without remounting children', () => {
  assert.match(splash, /inert=\{visible\}[\s\S]*\{children\}/)
  assert.match(splash, /setTimeout\(\(\) => setVisible\(false\), Math.max\(0, 10_000/)
  assert.match(splash, /clearTimeout\(timer\)/)
  assert.match(splash, /removeEventListener\('visibilitychange', finish\)/)
  assert.match(read('src/main.tsx'), /<StartupSplash>[\s\S]*<RootErrorBoundary>[\s\S]*<App \/>/)
})
test('original logo, five independent dots and three moving waves are preserved', () => {
  assert.match(splash, /src="\/pwa-512.png"/)
  assert.match(splash, /\[0, 1, 2, 3, 4\].map/)
  assert.match(splash, /\[0, 1, 2\].map/)
  for (const name of ['rotate', 'breathe', 'dot', 'wave-right', 'wave-left', 'wave-depth']) {
    assert.ok(css.includes('@keyframes startup-' + name))
  }
  assert.match(css, /startup-exit .8s 9.2s/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /safe-area-inset-bottom/)
})

test('six appliance icons, staggered ripples and light-to-logo timeline stay decorative', () => {
  assert.match(splash, /\['refrigerator', 'washer', 'dryer', 'dishwasher', 'oven', 'microwave'\]/)
  assert.match(splash, /startup-values[\s\S]*startup-appliances[\s\S]*startup-loading/)
  assert.match(css, /startup-carousel 9s linear infinite/)
  assert.match(css, /startup-logo-enter 1s 1.2s/)
  assert.match(css, /startup-ripple 2.8s/)
  assert.match(css, /\.startup-birth, \.startup-ripples \{ display: none; \}/)
  assert.match(css, /\.startup-appliance \{ position: static;[\s\S]*animation: none/)
})
test('native Back respects startup and native/HTML backgrounds are dark', () => {
  assert.match(read('src/App.tsx'), /classList.contains\('android-startup'\)\) return true/)
  assert.match(read('capacitor.config.ts'), /backgroundColor: '#020812'/)
  assert.match(read('index.html'), /background:#020812/)
  assert.match(read('android/app/src/main/res/values/styles.xml'), /windowSplashScreenBackground">#020812/)
})

test('starburst sends one brief set of rays beyond viewport and respects reduced motion', () => {
  assert.match(splash, /className="startup-starburst"/)
  assert.match(css, /perspective: 420px/)
  assert.match(css, /translate3d\(32px, 0, -1000px\)/)
  assert.match(css, /translate3d\(48px, 0, 412px\)/)
  assert.match(css, /startup-starburst 1.15s cubic-bezier\([^)]*\) both/)
  assert.match(css, /\.startup-starburst \{ display: none; \}/)
  const delays = splash.match(/const rayDelays = \[([^\]]+)\]/)[1].split(',').map(Number)
  assert.equal(new Set(delays).size, 16)
  assert.ok(Math.max(...delays) - Math.min(...delays) > 1)
  assert.match(splash, /animationDuration:/)
  assert.match(css, /\.startup-starburst i::before/)
})
