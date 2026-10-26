# CRM Interface Redesign

## Owner-approved release, 2026-10-25

Owner approved the preview and requested publication after checks. Mobile drawer
now enters from the right; the hamburger has a 16px right inset. Desktop keeps
the permanent left sidebar. Four responsive browser tests pass, including drawer
geometry and hamburger placement. Production build and bundle verification pass
using the existing public Maps browser key. The isolated PostgreSQL regression
suite passes all 542 tests, with zero failures or skips.

Deploy only generated frontend assets through the existing main deployment branch.
No Worker, database, native app or public booking logic changes are included.
The original coverage limitations below remain documented; this release does not
claim exhaustive device testing or exact parity with every reference screen.

Published frontend commit: `170ccb2` on `main` (previous release `ee17020`).
Live HTML references `index-ClQXJFZF.js` and `index-BkJk99xm.css`; both return
HTTP 200. Existing Google sign-in client ID and Maps key are retained. The live
sign-in screen displays Continue with Google; `/booking` returns HTTP 200.
No live financial actions, customer changes or device tests were performed.
Rollback: restore the `index.html` from `ee17020` in a new deployment commit;
its previous hashed assets remain available.

Branch: `feature/crm-interface-redesign`.
Source base: `feature/mcp-booking-integration` at `24439c1`; its frontend matches
the committed `codex/crm-calls-inventory` frontend. Main is a deployment branch,
not the source for this change. No AGENTS.md was found in the source or parent directories.
Uncommitted appointment-window and Android changes in the other working copy
were inspected and left untouched; reconcile those separately before any release.

The attached HTML supplied the layout and color tokens. The private reference
site could not be viewed because its sign-in returned a route error. This is a
review draft, not a claim of complete visual parity or production readiness.

## Coverage

| Existing surface | Implementation / verification |
| --- | --- |
| Shell, navigation, account and search | Shared toolbar and mobile bottom navigation; original handlers and role gates retained |
| Schedule, time off, job history | Existing timeline and actions retained; shared spacing, colors and card styles; schedule checked at four widths |
| Job Details | Original fields, notes, dictation, team and attachment handlers retained; desktop client column and live financial summary added; mocked save verified |
| Finance / Timeline | Original calculations and payment handlers retained; Finance and Payments disclosure checked; no financial operation executed |
| Clients | Existing cards, search and dictation retained; list checked at four widths |
| Inventory | Existing API/scanning/photo/stock handlers retained; empty state and Add Part dialog checked at four widths |
| Receptionist | All eight existing sections retained; section picker and Dashboard checked at four widths |
| Statistics | Shared tokens applied; complete chart/data-state review pending |
| AI Parts Search / receipts | Existing controls and handlers unchanged; exhaustive supplier, image and error-state review pending |
| Auth / roles / settings | Existing state and server contracts unchanged; full authentication and settings regression pending |
| Public booking / MCP / Retell / backend | No source changes; CRM theme is removed on `/booking` |
| Android / Stripe / push / native SMS | No native or integration source changes; device regression pending |

## Checks

- TypeScript build passed.
- Vite development-mode build passed. Standard production build stopped at the
  existing missing `VITE_GOOGLE_MAPS_API_KEY` guard; it was not bypassed and no
  production deployment was attempted.
- Four Playwright end-to-end cases passed at 390, 768, 1366 and 1920 px.
  Each covers Schedule, menu state, opening a job, mocked description save,
  Finance/Payments, Clients, Inventory/Add Part and Receptionist section selection.
- The tests block all external requests and use synthetic API fixtures. Maps
  therefore do not render in screenshots; no real order or payment was changed.
- Screenshots: `test-results/redesign-{screen}-{width}.png` (28 images).

Run: `node node_modules/@playwright/test/cli.js test --config playwright.redesign.config.ts`.
Local read-only preview: `node scripts/crm-redesign-preview.mjs` (port 5199).
The preview uses the actual React application with synthetic responses and denies
all non-GET API operations. It is not part of the production entry point.

## Remaining Before Acceptance

- Full reference comparison and visual refinement, including schedule composition.
- Full populated/error/loading states across supplier search, receipts, settings,
  statistics, all receptionist subsections and financial dialogs.
- Keyboard/focus audit for every pre-existing dialog and Android device checks.
- Real authenticated preview against a safe test backend and full regression suite.
- Owner preview review and publication approval received on 2026-10-25.

Rollback: revert this frontend-only change; no migration or API rollback is needed.
