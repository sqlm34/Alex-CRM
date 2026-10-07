# AI Parts Search

## Current rollout, 2026-10-07

The current target is cloud-only: no home computer, phone server or required VPS.
Reliable public catalog lookup now uses the website's observed structured endpoints:

- GET `/us-api/navapp/v1/model/number/{model}?manufacturer={brand}`
- POST `/us-api/navapp/v1/product/search`, body `{products:[{productNumber,manufacturerCode}]}`

`ReliableCatalog` validates exact model and brand, matches component words in diagram entries,
and follows only supplier-confirmed replacement references. It never obtains OEM numbers from AI.
`PARTS_PUBLIC_CATALOG_ENABLED=true` enables this limited real lookup through existing authenticated
CRM search routes. `CATALOG_ONLY` explicitly means account price and inventory are unavailable.
Unknown price is never zero; unpriced parts cannot be added as cost quotes.

Live read-only test: WTW5057LW0 / drain pump returned W11259498 -> W11399437,
plus W11089264 -> W11568797 (filter), in 2246 ms on one run. This is not an average.
Both remain visible candidates; the system does not automatically choose a component.
The signed-in supplier UI returned Reliable account price $100.31 and Marcone $96.71
for W11399437. These observations are NOT embedded prices and are NOT cloud-authenticated results.

The existing OpenAI key was inspected through its settings: Agents permission is None.
No key permissions were changed. Hosted agent sessions need `api.agents.read`,
`api.agents.write`, and `api.responses.write`, per the official Agents quickstart:
https://developers.openai.com/api/docs/guides/agents-api/quickstart
Hosted browser authentication must use dedicated authentication events, not chat messages:
https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use

Still incomplete: cloud supplier authentication/reconnect from Android, account pricing/stock,
Marcone connector, hosted fallback, session reuse, authenticated Add to Job acceptance.
The strategy module is tested but is not wired to a hosted agent. Do not call the feature complete.
No new database migration was required for public catalog lookup.

Additional checks: `node --test scripts/reliable-catalog.test.mjs scripts/parts-strategy.test.mjs`;
`node scripts/reliable-catalog-live.mjs` performs actual read-only Reliable requests.
The existing Playwright parts test now covers catalog-only search and disabled unpriced selection.

Production validation completed through the actual signed-in CRM Search suppliers button,
with Russian query `сливная помпа` and exact model WTW5057LW0. Cloudflare returned W11399437
and W11568797, not fixtures. An initial Worker transport incompatibility was corrected by
calling native fetch without binding it to a connector instance and rejecting manual redirects.
No parts, expenses, payments or supplier orders were added. The test generated search-history
records in job 58; the job's appliance/customer fields were not saved or changed.
Account-price/stock and Marcone acceptance still have NOT passed.

## Existing architecture and boundaries

- React/Vite `src/App.tsx` owns JobDetails and current tabs. Capacitor loads the live Hostinger frontend; no native browser automation.
- `worker/index.ts` authenticates bearer sessions, restricts jobs via `requireJobAccess`, and uses Neon. Owner access and technician access follow existing rules, not a new parallel authorization scheme.
- R2 attachments already validate content and support signed private viewing, Android camera files and HEIC conversion. Reuse these for label images.
- `parts_receipts` contains actual confirmed purchase expenses. Invoice finance items contain customer prices, including existing markup policy. Neither is a supplier quote store.
- Source is published to GitHub `source`; `main` contains static frontend output. Worker deployment uses a clean committed export. Unrelated Workiz work must not be staged or deployed.

## Implemented foundation

Job -> private attachment -> structured vision extraction -> explicit human confirmation -> part intent normalization -> independent supplier connectors -> supplier evidence -> human selection -> job part cost snapshot.

Modules: shared contracts/validation, Worker AI extraction, connector interface/normalization, additive storage, authenticated route handler, small JobDetails UI. Browser-specific integration will be a separate authenticated service, not part of Worker/Android.

Additive entities: `appliance_scans`, `part_searches` (normalized response snapshot), `job_parts` (selection and supplier unit cost), `parts_request_usage` (per-user daily budget). Selected costs are quote snapshots, not purchases; existing receipt expenses and Net Income remain untouched to avoid double counting.

## Supplier inspection, 2026-10-07

- Both business accounts were authenticated in the built-in browser by the owner. No passwords, cookies, session tokens, screenshots or browser profiles were copied.
- Reliable Parts: the search field "Search millions of parts and models" resolves WTW5057LW0 to `/us/content/#/model/WTW5057LW0/Whirlpool`. Keyword `pump` leads to replacement W11399437 for W11259498. "View details" opens `/us/content/#/part/WPL%20%20W11399437` with account price and warehouse stock. Initial loading displays $0.00: this must never be parsed as a real price. Product details can say "Found in 0 Models" despite the model diagram providing a replacement match; preserve the actual model-page evidence.
- Marcone: exact model selection opens `/Model/Index?ModelId=727033&ModelNo=WTW5057LW0`. "05 - GEARCASE, MOTOR AND PUMP PARTS" contains W11259498 -> "USE WPL W11399437". Clicking the replacement opens a new product tab; use "Your Price", not "Retail Price". These example IDs are observed fixtures, never general search constants.
- No official supplier API, permission for unattended automation, or server-hosted authenticated session has been established. Live connectors return NOT_CONFIGURED without a private service binding. Mock results belong only in tests.

## Remaining supplier rollout gate

Owner login in a dedicated server-hosted browser session, permission review, exact-model diagram/OEM evidence inspection, price/stock parsing fixtures and negative cases, secure encrypted session persistence, and deployment of a dedicated automation service. CAPTCHA/MFA/re-authentication requires the owner. Never import browser profile/cookie files from the user's machine. Do not place orders.

The future service must isolate sessions by authorized business/account, encrypt session material with a secret-manager key, use short-lived authenticated service requests, fixed supplier allowlists, redirects validation, bounded concurrency/timeouts, and no credential screenshots or logging. Signing into a local browser alone does not create a server-side persistent session.

## Rollout policy

Do not represent unconfigured connectors as connected, verified, or having account prices. Return explicit status and no fabricated results. Search results must include exact model/OEM provenance before Add to Job is enabled. Do not expose raw supplier errors, arbitrary URLs, secrets, or cookies to clients.

## Current files and API

- `src/PartsSearch.tsx`, `.css`: collapsible Job Details panel, Android camera/gallery, HEIC conversion, editable label fields, explicit model confirmation, Russian/English query, independent supplier status, comparison, quantity and saved selections.
- `src/api.ts`, `src/App.tsx`: existing bearer-auth transport and job integration. No nested forms.
- `shared/parts.ts`: identity/result schemas, exact-model evidence checks, integer cents, supplier URL allowlists.
- `worker/parts/{recognition,connectors,storage,routes}.ts`: structured Responses API, replaceable supplier adapters, quota/idempotency and persistence.
- `worker/index.ts`: existing auth/job and private attachment authorization surrounds the new handler.
- `migrations/2026-10-07_ai_parts_search.sql`: four additive tables, also created idempotently by the handler. Foreign keys cascade on intentional permanent job deletion, preserving the existing delete workflow.
- `scripts/parts-search.test.mjs`, `e2e/parts-search.spec.ts`: offline supplier/AI fixtures, isolated real PostgreSQL and desktop/mobile interaction tests.

Routes: GET `/api/jobs/:jobId/parts`; POST same path to select `{searchId,resultId,quantity}`; POST `/parts/scan` with `{attachmentId}`; POST `/parts/search` with `{identity,query,confirmed:true,requestKey}`; GET `/parts/search/:id`.

30 AI operations per user per database UTC day. Scans claim a unique job/attachment before invoking AI; failed or abandoned claims can retry. Searches deduplicate by job/request UUID and reject changed payloads. Selected parts take prices only from the server's search snapshot, reject unverified/stale (>15 minutes) results, and deduplicate the same search/result. They do not create a receipt expense, invoice line or supplier order.

## Configuration and service contract

Existing Cloudflare secret `OPENAI_API_KEY` enables label recognition; the existing direct Responses API pattern and gpt-4.1-mini model are reused. No additional client secret or native Android plugin is needed. Private R2 image storage uses existing bindings.

Optional `PARTS_SERVICE` is a private Cloudflare Fetcher binding to a separately deployed gateway. It is NOT a supplier API and is absent in production. Public catalog lookup does not require it. Future authenticated providers must use cloud infrastructure; a persistent Chromium host or VPS is not a requirement.

Internal POST contract: `/{reliable|marcone}/{session|search-model|search-part|part-details}`. Body for search-model is `{identity,intent}`; other lookups use `{partNumber,model}`. Response is `{status,results}` per shared types. Session results are empty. No arbitrary URLs, credentials or account selectors come from the client. Deadline 25 seconds, maximum 50 results. Implement and test adapters against saved sanitized HTML fixtures before enabling the binding.

Reconnect is NOT implemented in CRM yet. After hosting is selected and supplier automation is permitted, owner must sign into the dedicated protected server browser, not send passwords in chat or export local browser cookies. CAPTCHA/MFA stays interactive. Encrypt persistent session data, restrict host access and account ownership, and return LOGIN_REQUIRED after expiry. Do not repeatedly replay passwords.

## Validation and deployment

- Node 24; `npm run build`.
- Isolated PostgreSQL user/database `webhook_test`, password `local-test-only`, loopback only; set `GOOGLE_ACTIONS_TEST_PORT`, then `node --test scripts/parts-search.test.mjs scripts/receipts.test.mjs`. Never point these tests at production.
- `node node_modules/@playwright/test/cli.js test e2e/parts-search.spec.ts e2e/receipts.spec.ts e2e/photo-gestures.spec.ts` starts the local Vite test server on 5186. Supplier traffic is mocked, not purchased or scraped.
- Worker module check: `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target ES2022 --moduleResolution bundler --module ESNext --lib ES2022,DOM --skipLibCheck worker/parts/routes.ts`.
- Deploy only committed AI Parts changes from a clean Git export. Do not deploy the unrelated dirty Workiz code. Worker first, frontend second. Push source to `source` and built static output to existing `main` deployment worktree.
- Android acceptance: Job -> Details -> AI Parts Search -> Scan label/Gallery, approve camera access, edit ambiguous model and brand, confirm, enter the component, search. Original photo remains in Attachments. Reliable returns public catalog candidates only; Marcone stays unconfigured until cloud authentication rollout.

## Remaining work (not production-ready supplier search)

Deterministic browser adapters, encrypted server session store, owner reconnect UI, hosting/provisioning, supplier permission review, sanitized parsing fixtures, separate supplier timing diagnostics and live acceptance tests. No normal persistent browser service is assumed to exist in a Worker. Current automated tests exercise comparison and Add to Job using fixtures; they do not certify live supplier integration. Physical Android camera and live OpenAI label extraction still need acceptance testing.
