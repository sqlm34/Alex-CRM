# Android animated startup

## Implementation

- Branch: feature/android-animated-splash; based on source b7e1624cedecdb28c9d3d50adb3449bfea73e207.
- StartupSplash.tsx mounts the application immediately inside an inert wrapper. The overlay is a sibling, not a replacement for the application.
- Android only, excluding /booking. No web delay, storage flag, API request or payment operation.
- Duration: 10 seconds from React startup. CSS fades the overlay during 8.8-10.0 seconds; a cleaned-up timeout removes it. Visibility restoration checks elapsed time rather than replaying the intro.
- Existing loading/error UI remains mounted beneath the overlay. No assumption that a network request succeeds within ten seconds.
- Logo: existing public/pwa-512.png, unchanged, 512 x 512. This repository asset has yellow lettering, including APPLIANCE REPAIR; it was deliberately not recolored or recreated.
- StartupSplash.css: logo entrance 1-2.5 seconds, 2.4-second gentle breathing, separate 5.5-second rotating CSS ring and orbiting glow/trail.
- Five dots use independent 270 ms offsets within a 1.35-second cycle.
- Three SVG light-wave layers move independently over 5, 6 and 7 seconds using transforms; no video/GIF dependency.
- Reduced motion keeps simple fades and removes rotation, breathing and moving waves/dots.
- Layout uses safe-area padding, dynamic viewport height, a limited 48vw logo and short-landscape adjustments. Font sizes do not scale with viewport width.
- The shared Back handler consumes Back while the startup overlay is active. The inert wrapper prevents clicks and keyboard focus reaching underlying controls.
- index.html supplies a native-only early dark background; capacitor.config.ts and Android styles supply a dark WebView/window/status/navigation background. Booking and backend behavior are unchanged.

## Verification

- npm ci --prefer-offline --no-audit: passed.
- npm test: 253 passed, 0 failed, 0 skipped, including existing PostgreSQL scenarios on a loopback-only disposable test database. The local test server was stopped afterward. No production DB connection.
- npx tsc --noEmit and npm run build: passed.
- npm run verify:production-bundle: passed. Build reused the existing public browser Maps key without printing it or adding it to Git.
- git diff --check: passed.
- Lint: 16 existing source diagnostics, identical normalized baseline; no added source diagnostic. After Gradle compilation ESLint also scans generated native-bridge.js and reports three generated-file diagnostics; these are not tracked source changes.
- npx cap sync android and Gradle :app:assembleDebug --no-daemon: passed. No signing keys, release signing, version bump or installation.
- Playwright local-only harness: 320x568, 360x800, 393x873, 412x915, 393x852, 800x360, 1280x800, plus reduced motion. Animated transforms, original logo decode, five dots, no horizontal overflow, no loading/wave/text overlap, approximately ten-second removal, retained draft, continuing background polling and no replay on SPA navigation verified.
- Harness page errors: none. External requests are blocked in the harness.
- Harness is simulated Android, NOT proof of native device behavior. adb devices found no attached device. Real WebView cold start, Android system bars, hardware Back and device frame rate remain to be checked on a device.

## Local preview and artifacts

Run npm run dev -- --host 127.0.0.1 --port 4196 --strictPort.
Open http://127.0.0.1:4196/scripts/startup-splash.preview.html.
This explicit development-only harness contains synthetic content and makes no CRM writes. It is not an entry point in the production bundle.

The reproducible browser check is scripts/startup-splash.browser.mjs.
Set PLAYWRIGHT_MODULE to an existing Playwright index.mjs and SPLASH_ARTIFACTS to an output directory outside Git, then run it while Vite is serving on port 4196.

Screenshots and a mobile WebM recording are saved outside Git in:
C:/Users/sqlm1/AppData/Local/AlexCRM/SplashLab-20260910/final/

## Release boundary

No merge, deploy, production change or APK installation performed.
The animated web overlay is frontend code. The native pre-WebView color fix requires a separately approved signed APK update; the currently installed APK has not received that change.
No Worker, Neon, Stripe, Firebase, notification, finance or API contract changes.
