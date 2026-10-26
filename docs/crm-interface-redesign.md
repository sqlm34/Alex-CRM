# CRM Interface Redesign: Review Draft

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
- Owner review and approval. Do not merge or publish this draft automatically.

Rollback: revert this frontend-only change; no migration or API rollback is needed.
