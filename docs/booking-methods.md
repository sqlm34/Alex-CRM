# Booking entry selector

Frontend-only entry selector in `BookingMethod.tsx`, used by the existing
`BookingPage`. The manual form stays mounted when hidden, preserving its state.
The unchanged website widget is loaded once using its existing public config;
its launch button remains the entry point. Active/connecting voice calls and
manual submission lock method switching. Existing confirmed online bookings
also lock switching. No API, CRM or Retell logic changed for this feature.

## Widget provenance

`public/voice-booking/{widget.js,index.m-VQGGVKTS.js,chunk-EK7ODJWE.js}` are
unchanged copies of the website's `js/voice-booking/` build. The CSS is copied
unchanged from `css/voice-booking.css`. `booking-entry.js` only mounts it with
the same public endpoint/site key as the website's `js/script.js`.
Update these copies together when the canonical website widget changes.

## Verification

Start Vite on 127.0.0.1:5196; run `node scripts/booking-methods.e2e.mjs`.
The test stubs service traffic, never starts a call or submits a booking, and
generates evidence PNGs from the actual existing components. It checks the
entry screen, manual step retention, voice mounting, active-call guard and
overflow at 1440, 768, 390 and 320 pixels. Screenshots go to artifacts.
TypeScript build checks also pass.

## Production release (2026-10-23)

Published selector and inline voice layout through static main branch,
latest release 4cb979c. Production is https://www.aleksappliancerepair.com/booking/.
The selector uses existing Lucide icons, brief descriptions and full-width CTAs,
not screenshot previews. Cards stack on mobile and share the site font/colors.
The existing mounted widget is moved into a persistent host, not recreated.
It is moved before launching verification and never re-appended on rerenders,
preserving the Turnstile iframe. The browser test asserts this initialization order.
Booking-scoped CSS hides the floating launcher and centers the existing panel.
The duplicate Open voice booking button is removed. Only while a call is active,
a View booking order control restores a minimized order dialog. The inline entry
panel is restored when the call ends, so retry does not require a page reload.
The marketing website widget is unchanged. The manual form remains mounted.

Production origin configuration now allows both booking domain variants while
preserving marketing origins, unchanged Worker code and all other bindings.
Worker version: dfe6c9e8-0193-42da-b672-cc3c620c1e77.
Turnstile loads its normal verification challenge on the booking domain.
Run scripts/booking-live-smoke.mjs to verify the published entry and both paths.
Neither browser smoke test starts a call or creates an order. A paid real-call
test was authorized, but must be reported separately from these smoke tests.
An attempted live start displayed the widget's HTTP 429 busy message. No test
order has been confirmed. Do not describe this attempt as an end-to-end pass.
Production builds require VITE_GOOGLE_MAPS_API_KEY.

Do not deploy unrelated pending appointment-hours changes with this feature
without reviewing them separately.
