# Nestwise integration — development, disabled by default

Companion to the first large Nestwise delivery. This checkout starts at
`b407ee3`; unrelated changes in the original CRM checkout are preserved.

## Migration and rollback plan

Apply the integration migrations in dependency order (not alphabetically):
1. `2026-10-20_nestwise_outbox.sql`
2. `2026-10-20_nestwise_review.sql`
3. `2026-10-20_nestwise_cost_corrections.sql`
4. `2026-10-20_nestwise_lifecycle.sql`
5. `2026-10-28_nestwise_inventory_guard.sql`

The integration fixtures execute this exact order from a fresh database; CI
restores the resulting schema and immutable evidence into a separate database.

Apply additive integration tables/functions/triggers only to an isolated CRM
copy first. Capture and dispatch both default OFF. Job/payment/receipt schemas,
Stripe charging and customer integrations retain their current behavior.
Capture runs in the same PostgreSQL transaction as a source mutation, so a
committed financial change cannot lose its integration record.

The producer must distinguish invoice sale prices from purchase costs. Confirmed
parts receipts provide cost evidence, but do not by themselves establish a cash
payment date or settlement type. Offline payments use `offline_payments.payment_date`,
not the JSON materialization timestamp. Voiding a payment is not automatically a
customer refund. Unsupported corrections stop for review rather than inventing
facts. Historical baselines require a dry-run and owner approval before delivery.

Before enabling a canary: verify receiver connection, scoped signing secrets,
financial scenarios, duplicate/retry/concurrency tests, database restore and CRM
regression. Never activate a producer against the live CRM as part of development.

Rollback disables capture/dispatch and reverts application code. Preserve captured
changes, event identities, delivery attempts and ACKs; do not delete financial
history or rewrite payments. No production deployment has been performed.

## Current implementation checkpoint

The migration captures projected job changes and source offline-payment facts
atomically, with the actual `payment_date`. Personal notes and customer fields
are excluded. Capture defaults off. Conversion from captured changes to canonical
Nestwise payment events is implemented for new successful offline payments;
capture does not invent refunds from voids. Materialized job-payment updates do
not emit a second payment. Unknown/changed/deleted facts stop their stream for
review without blocking other orders. Stripe, parts and corrective events remain
pending and must not be silently approximated.

Outbox delivery preserves event bytes and IDs, uses fresh HMAC nonces on retry,
leases ordered events, verifies durable ACK identity and records bounded retries
and dead letters. The existing scheduler invokes it only when explicitly enabled
with `NESTWISE_ENVIRONMENT=staging`. No configuration has been enabled.

Thirteen targeted tests pass; preview Worker dry-run builds. A separate two-database
integration test signs real CRM output and sends it through the Nestwise receiver:
two partial payments retain their dates, and a lost ACK/retry does not double the
journal. Owner-only sync/retry endpoints, an opt-in UI, immutable operator audit
and paginated read-only historical dry-run are implemented. The broad CRM suite
has six unavailable-PostgreSQL failures plus three job-text/startup source
assertion failures. The same three assertions fail against the unmodified b407ee3
sources and tests, verified using a separate extracted baseline. Full acceptance
remains open; these existing failures are not being hidden or weakened.

Still required: parts/Stripe/correction/finalization provenance and approved
resolution workflow, scoped deployment permissions, isolated real-PostgreSQL
concurrency and restore, browser acceptance and receiver staging verification.
Historical dry-run never imports data; refunds remain unknown where source
evidence is absent. No flags, live migrations or deployment have been enabled.

Optional Stripe/parts source tables now have projected evidence triggers when
present at migration time. Pending attempts and draft receipts do not produce
financial facts; confirmed changes roll back with their source transaction.
No card metadata, supplier text or user identities enter these captures. Missing
actual payment dates remain missing; recorded_at is never relabeled as paid_at.
These sources remain held for review until their canonical conversion is complete.
Seven outbox tests (14 targeted tests in total) pass after this addition. Before
activation verify both optional triggers exist; installing source modules later
requires a versioned follow-up migration, not silent loss of source coverage.

## Reviewed source conversion — 2026-10-20

New additive migration `2026-10-20_nestwise_review.sql` follows the outbox
migration. It is not deployed. Owner-only source review shows the captured
before/after evidence and records an immutable actor, actual payment date and
explanation. No OCR, update timestamp or receipt confirmation implies payment.

A first recorded USD Stripe attempt with verified gross/fee/net arithmetic can
produce an ordered payment and separate fee after explicit confirmation that
both were paid on the specified date. A first confirmed parts receipt can produce
a paid-cost fact after explicit payment confirmation. Unsupported currencies,
missing facts, historical baselines and changes to previously confirmed facts
remain held. This does not approve tax treatment or finalize an accountant report.

Command retries retain their identity. A per-order row lock and per-source
advisory lock prevent duplicate release across simultaneous confirmations or
orders. Source reviews stay in CRM; private operator explanations are not sent
in the financial event body. The materialized Stripe payment is recognized as
already emitted, preventing a second payment event.

Validation: 18 targeted local cases, 17 passed and one PostgreSQL-only concurrency
case deferred to CI; separate signed receiver test passes with reviewed Stripe
payment/fee and paid parts, including duplicate sends. TypeScript, ESLint and
Worker dry-run are checked separately. Restore verification now includes source
review evidence. Live source review/browser acceptance remains pending; capture
and dispatch stay disabled. No CRM production schema or app changes.

## Paid-cost correction boundary

Migration `2026-10-20_nestwise_cost_corrections.sql` introduces immutable cost-correction attestations
and an owner-only command. It consumes only the next captured change to the same
confirmed parts receipt, retains its original payment date and references the
latest emitted cost revision. An edit is not a new purchase or supplier refund.
Changed/deleted originals, currency changes, missing prior costs, changed dates
and non-cost source mutations remain held. The existing initial confirmation
endpoint must continue rejecting corrections. No source tables or payment
mutation paths change. Rollback disables capture/dispatch and retains all audit
and outbox rows; only disposable local databases receive the migration initially.

Implemented owner-only `/api/nestwise/source-correction` and a distinct UI
attestation for correcting an originally misrecorded paid amount. The initial
confirmation route still rejects corrections. Higher, lower and zero replacement
totals preserve a linear reference chain and original payment date. Changing the
source hash or original date remains blocked. Audit reasons stay in CRM.

Local validation: 17 targeted cases pass; one PostgreSQL concurrency case runs
in CI. The separate signed receiver test verifies increases, decreases, zero,
idempotent command and delivery retries against the real receiver journal.
TypeScript, changed-file ESLint and Worker preview dry-run pass. CI additionally
checks simultaneous correction approval and backup/restore of correction audit.
No live migration, capture, dispatch or deployment has been enabled.

## Lifecycle mutation plan

An additive lifecycle review records owner-attested completion, reopening or
empty-order cancellation against the next captured job status transition.
Finalization compares canonical emitted monetary totals at the receiver; it
does not post revenue and does not approve a tax report. Simultaneous payment
edits, historical baselines and cancellation with nonzero financial balances
remain held. Preserve all original mutations and audit rows on rollback.

Implemented `2026-10-20_nestwise_lifecycle.sql`, the owner-only lifecycle review
endpoint and explicit status confirmation UI. Canonical totals include cost
correction deltas; receiver integration tests compare both nonzero Stripe totals
and corrected-to-zero costs. Finalize/reopen/void assertions leave the journal
transaction count unchanged across retries. Cancellation with money and mixed
status/payment changes is rejected. PostgreSQL CI covers concurrent approvals
and restoration of immutable lifecycle evidence. Live deployment stays disabled.

## Browser acceptance on disposable data

Run `NESTWISE_UI_FIXTURE=1 node scripts/nestwise-ui-fixture.mjs` with Node 24.
The explicit opt-in starts a loopback-only server at `http://127.0.0.1:8084`.
It bundles the actual `NestwiseSync` component with an API transport limited to
the fixture origin, calls the real admin handler and applies all four migrations
to disposable PGlite. It never reads cloud credentials or live databases.
`--check` verifies seeding and bundling in CI without opening a listener.

Browser acceptance on 2026-10-20 passed: cost correction 30 to 45 USD retained
the 2026-10-10 payment date; finalization added one assertion; failed delivery
returned to pending with its original ID. Each scenario deliberately returned
503 AFTER its database commit, then succeeded when the UI retried the same
command. Final audit counts were exactly one correction, one lifecycle review
and one delivery retry. Historical preview remained read-only and explicitly
flagged an unmaterialized payment. No records were imported.

This confirms local component/admin/database integration, not deployed CRM
authentication, cloud permissions, phone layout or live delivery. The separate
signed receiver CI covers downstream posting. The old preview config names the
existing `alex-crm-api` Worker; it must not be treated as an isolated staging
service or deployed for this acceptance run.

## Separate cloud provisioning profile and bootstrap acceptance

`wrangler.nestwise-staging.json` targets `alex-crm-nestwise-staging`, never
`alex-crm-api`. Initially workers.dev and preview URLs are disabled; there are
no routes, cron triggers, R2 bindings or external service credentials. Dispatch,
Stripe, attachments, public parts catalogue and Google Actions are disabled.
`npm run worker:nestwise-staging:dry-run` validates this inert profile before
building. CI rejects changes that accidentally target production, expose a URL,
add a binding/cron/environment override, enable dispatch, or insert plain secrets.
This checks the repository configuration, not remotely stored secrets or CLI
overrides. No deploy command or cloud resource has been created by this step.

Fresh-database acceptance bundles the actual Worker and substitutes only the
Neon transport with disposable PGlite; all network fetches fail closed. It uses
the existing SQL migrations rather than reduced fixture table definitions:

1. Apply `supabase-schema.sql` in the empty isolated database.
2. Apply `2026-09-04_add_independent_job_text_fields.sql` BEFORE the first auth
   request. Without it, auth startup fails on the missing `jobs.details` column.
3. Initialize auth through the Worker with an explicitly approved synthetic
   owner. This creates users/sessions and adds the expected payment columns.
4. Apply `2026-09-06_add_offline_payments.sql`, `2026-10-07_parts_receipts.sql`,
   `2026-10-07_receipt_discard.sql`, `2026-10-11_receipt_restore.sql`.
5. Apply the four integration migrations in the dependency order above.

The test verifies password registration/login, owner authorization, denied
anonymous/invalid/expired tokens, denied technician access, and a 404 for the
integration route in production. Capture stays false and the outbox stays empty.
This is acceptance for the auth/integration surface only, not a complete CRM
schema bootstrap or a cloud deployment. Other CRM features need their own
existing migrations. Before cloud activation, provision a distinct database and
scoped role, verify database identity and remote secret names, protect the access
surface, take a recovery snapshot and record migration checksums. Do not copy
production data, secrets or storage bindings. Public access and delivery require
a separate reviewed activation change after these checks.

## Cloud provisioning checkpoint — 2026-10-20

With owner approval, created database `alex_crm_nestwise_staging` on the existing
Neon staging branch and role `alex_crm_nestwise_worker`. The role has no superuser,
CREATEROLE, CREATEDB or BYPASSRLS privileges and belongs to no other roles. Database
privilege checks confirmed CONNECT to the new database and no CONNECT/CREATE on
`nestwise_staging`. No production CRM database or records were accessed.

Created the separate `alex-crm-nestwise-staging` Worker from CRM `0c9289c`.
Initial code version: `edfb6676-a53d-46c1-8d5f-88563e545fe6`; adding its database
secret creates a later configuration version. The only remote secret name is
`DATABASE_URL`, saved encrypted in Cloudflare. No credential is stored in source
or local files. Domains UI confirmed both workers.dev and preview URLs disabled,
with no routes. No cron or storage binding was added. The Cloudflare dashboard's
"Production" tab denotes this separate Worker's primary version, not a release
of the live CRM or Nestwise production environment.

`node scripts/nestwise-bootstrap-plan.mjs` generates a transaction for this EMPTY
database only. It derives auth DDL from the actual Worker against disposable
PGlite and combines existing SQL sources in the tested dependency order. It
records 11 version/hash entries in `public.crm_staging_migrations`. All tables
belong to the dedicated role; the installer gets temporary SET ROLE permission
and revokes it at the end. Database CREATE is also revoked after schema creation.
The first cloud attempt failed at SET ROLE and was rolled back before tables
were created; the generator now handles Neon's explicit membership requirement.

Wrong database and nonempty database guards reject execution; rerun never
overwrites an installation. A failed transaction must be rolled back before
retry. Recovery for this initial empty database is the versioned bootstrap;
subsequent data-bearing migrations require a snapshot/restore drill. Restore a
shared-branch backup into a separate recovery branch, never over the existing
Nestwise staging database. Cloud auth and end-to-end delivery acceptance remain
pending: the Worker has no public entry point or approved app account yet.

Cloud SQL verification after bootstrap: 11 migration records, capture false,
zero outbox events and zero tables owned by the wrong role. Neon retains its
automatic creator administration membership (`cloud_admin` grantor, ADMIN true,
INHERIT false, SET false); this is not the temporary SET permission. The temporary
grant allowing schema installation was removed. The runtime role itself still
inherits no roles and cannot connect to the Nestwise database.

Private Cloudflare HTTP tester then exercised the actual Worker/Neon connection:
anonymous `/api/auth/me` returned 401 after schema initialization; a synthetic
10-minute owner session read `/api/nestwise/sync` with 200 and an empty disabled
queue; changing its user to technician returned 403; explicitly expiring that
session returned 401. Final SQL check found zero active test sessions and zero
outbox events. No password was assigned to the synthetic user, and the bearer
was cleared from the tester. No public endpoint was enabled. CI 39527604758
passed for 766476f, including isolated bootstrap and full producer/receiver tests.

## Bounded cloud canary activation

The dispatcher now requires an explicit start and expiry, at most one hour apart.
Missing, invalid, future or expired windows do not process or lease events. The
deadline is checked again after acquiring leases; expired leases recover normally
without inventing a failed delivery. Requests already in flight may finish within
their 25-second timeout. This is staging acceptance, not continuous live syncing.

`node scripts/nestwise-canary-plan.mjs <ISO-start>` prints a secret-free profile
derived from the validated inert configuration. It targets only the separate CRM
Worker and the Nestwise staging receiver, with public URLs and cron still absent.
Keep generated configuration outside source control. Signing material belongs
only in the two Workers' encrypted secrets, with matching receiver key expiry.
The connection `crm-synthetic-canary` must be scoped to a NEW synthetic workspace
and account. Never bind it to an existing financial account.

Cloud canary completed on 2026-10-21 UTC (October 20 Indianapolis). Dedicated
connection `crm-synthetic-canary` was scoped to synthetic workspace/account UUIDs
94000000-0000-4000-8000-000000000001/2. Two source payments for order
`SYNTHETIC-canary-94` produced $100 on October 19 and $250 on October 20. Both
received durable posted ACKs. A controlled lost-ACK injection reset ONLY delivery
metadata for the first synthetic event, retaining its ID, body/hash and attempt
history. Re-delivery remained two receiver events, two journal transactions,
balanced entries (sum zero), and clearing 35000 cents. Account overview and journal
were checked in the signed-in browser. Synthetic failed attempts remain auditable;
only next-attempt timing was advanced to avoid waiting during fault recovery.

Cleanup verified: source capture false, zero pending events, both ACKed, zero
active synthetic sessions, receiver connection disabled, health financialIngestion
false. Receiver key map was cleared; producer key replaced with a disabled value.
The inert private Worker configuration was restored (no binding, public URL or
cron). Synthetic evidence remains for review; no live records were used.

The canary uses a service binding scoped to `nestwise-staging` because the
Cloudflare dashboard preview returned 404 for public Worker-to-Worker requests.
Signing and receiver authorization still apply. Signed delivery uses
`redirect: manual`: workerd rejects `redirect: error`, despite Node accepting it.
Redirect responses are retried without following Location or forwarding signed
headers. A pinned Miniflare/workerd regression constructs the actual Request
inside a Worker and verifies that a 307 is never followed.

`POST /api/nestwise/dispatch` runs one bounded batch for an authenticated owner
inside the staging window. It accepts no body or query overrides, returns actual
queue state and uses the same ordering/leases as the scheduler. This permits
acceptance in Cloudflare's authenticated HTTP tester without a public CRM URL or
cron. Empty POST streams are allowed, nonempty input is rejected. Diagnostics
contain only allowlisted error categories, never headers, secrets or event bodies.

Integration CI 39528884506 and Android debug build in 39528884658 passed after
merging current `source`. General CRM tests in that run: 454 passed, 8 failed,
1 skipped. Failures concern older job text assertions, push creation count, two
hardcoded PostgreSQL ports, receipt restoration and shared Stripe fixture schema.
These are release blockers; do not present the entire CRM suite as green.

Follow-up fixes in this same PR address the failed general checks: restore receipt
requests were reaching confirmation validation because the restore branch was
outside the receipt-ID block; the branch now executes before confirmation. Two
PostgreSQL tests now honor the CI port. Stripe contract tests use their own schema
rather than mutating shared public tables. Existing source assertions now reflect
the already-merged separate Description/job-text behavior and receptionist-created
pushes; no application text or notification behavior was changed for those checks.
The general CI result must be rechecked on the new head before marking ready.

## Production delivery preparation (2026-10-27)

Production transport now has a separate fail-closed profile. This code change
does not activate capture, modify the live CRM database, or send real records.
The default production Wrangler configuration remains unchanged.

Before activation: verify the four versioned outbox migrations against a fresh
backup restored into a separate database; verify source mappings and the receiver
workspace/account; obtain approval for the production signing key and live data
transfer. Keep historical import separate from forward capture, review its preview
and totals, and preserve stable source event IDs. Never copy synthetic identities.

The production profile requires all of:
- `NESTWISE_ENVIRONMENT=production` and `NESTWISE_PRODUCTION_APPROVED=nestwise-production-v1`.
- Exact endpoint `https://nestwise.universestitch.com/v1/crm/events`, connection
  `alex-crm-production`, and service binding `NESTWISE_RECEIVER` to `nestwise-production`.
- A valid key ID and 32–64-byte hexadecimal signing secret stored only in secrets.
- Explicit start/end timestamps at most 30 days apart, aligned with receiver key
  expiry. Missing, future, expired or overlong windows stop before database work.
- `NESTWISE_DISPATCH_ENABLED=true`; keep false until all acceptance gates pass.

The existing scheduler processes bounded batches. Production never falls back to
public fetch. Expiry and the kill switch are rechecked after leasing; in-flight
requests may finish within their 25-second timeout. Owner-only diagnostics remain
available with a valid production profile even when delivery is disabled so failed
events can be reviewed. Manual dispatch cannot override destination or credentials.
Disable sender and receiver first on rollback; retain outbox/attempt history and
lease recovery. An expired profile requires reviewed renewal, not a perpetual key.

Integration CI now pins the receiver to b6d179bcb07b4fad6deb32cb588addaf4b0580d5.
Production activation and a real-record acceptance are still pending.

2026-10-28 release reconciliation:
The integration branch incorporates the deployed inventory/MCP source lineage
(`feature/mcp-booking-integration` at 24439c1). Deploying the older `source`
checkout alone would remove already-live features. Preserve the active Worker's
bindings and secrets; the repository default Wrangler file is not a complete
inventory of live settings. The verified active version before preparation is
9f7ab192-49f5-44e2-967c-04f8839c05b2; recheck before any release.

A fresh production snapshot was restored to a NEW Neon branch. All four initial
migrations committed there with source-table counts and fingerprints unchanged,
capture false, zero outbox events and four capture triggers. The fifth additive
migration also committed on that restored copy. No live CRM migration or
connection switch was performed.

Inventory-backed parts receipts now retain their usage provenance. Database
triggers reject both purchase approval and cash-cost correction for stock usage,
rolling back the entire attempt. This includes old captured projections via a
source-row check. The original purchase/payment must be linked in Nestwise;
consuming previously purchased stock is not a second cash payment. Such CRM
events remain held for explicit resolution; they are not silently imported as
expenses. Existing review functions, historical facts and original payments are
preserved. Apply the new migration after the four earlier versions everywhere.

Guarded inert code release:
The Cloudflare dashboard confirms `worker-production` is the production build
branch; `source` uses `wrangler versions upload --config wrangler.preview.json`.
Merging this PR does not itself activate the code. Recheck these settings if they
change. Do not use the default `wrangler deploy` for the live release.

Build a dry-run bundle, record its SHA256, and run
`node scripts/nestwise-production-release.mjs EXPECTED_VERSION BUNDLE EXPECTED_SHA256`.
The default only reads metadata. `--apply` explicitly uploads and activates an
inert version after comparing all bindings, runtime and handlers. The command
preserves existing secrets via keep_bindings and forces delivery false. It
rejects split deployments, changed active versions and unpublished versions
whose secret inheritance needs separate review. It never creates a key, changes
capture in the database, enables delivery, or connects a new service binding.

2026-10-28 production variable budget:
The live Free Worker cannot fit eight additional text variables. NESTWISE_CONFIG
accepts only the eight non-secret Nestwise options as a JSON object. The signing
secret and receiver service binding remain separate. Both fetch and scheduled
entrypoints normalize it. Invalid JSON, oversized config, unknown keys and
non-string values disable production dispatch. Explicit bindings take precedence
so a false kill switch remains authoritative. Unrelated CRM settings are retained.
