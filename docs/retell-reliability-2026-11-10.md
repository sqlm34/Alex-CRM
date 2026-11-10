# Retell reliability release, 2026-11-10

## Evidence

Call `call_c3c55d91639d674317b342f89f3` used agent V25.
Retell logged ECONNABORTED after 15002 ms for checkServiceArea and 15002 ms for requestCallback.
Earlier getBusinessPolicies took 905 ms and checkServiceEligibility 466 ms.
Production database inspection found tool_count=2, no location ZIP, and only an automatically generated abandoned callback, not the confirmed named callback.
The precise historical network/database hop causing those two timeouts remains unproven. Do not attribute it to geocoding, expired authentication or a database lock without evidence.
The word Darren was present in the user ASR transcript during overlapping speech. The model treated it as a possible name change; no CRM name substitution was observed.

| Problem | Evidence and change | Verification |
| --- | --- | --- |
| ZIP | 15 s Retell timeout; defer nonessential location analytics with waitUntil, retain current database-backed coverage policy | Signed isolated-cloud routes accepted 46033 and rejected 99999; last checkServiceArea measurement 116 ms |
| Callback | No confirmed callback persisted in the incident; atomic insert/replay/result verification in one SQL statement, one safe provider retry with identical details | Concurrent local requests and isolated-cloud replay produced one callback |
| Silence | Talk while waiting was disabled | Enabled and reloaded four static progress sentences in Retell; no claim of success in them |
| Name | ASR supplied an isolated Darren during overlap | Added explicit-correction-only rule and neutral clarification; prompt assertions pass, live speech accuracy not yet verified |
| Flow | Representative request continued into appointment intake | Callback requires only name/phone/reason; accept unknown brand/age; refrigerator/freezer compartment stays one appliance |

## Implementation

- worker/receptionist/routes.ts: atomic callback persistence, deferred analytics hook, numeric query timings and fixed stage/status logs without caller data, signatures, SQL text or exception messages.
- worker/index.ts: connect deferred work to Cloudflare waitUntil.
- worker/receptionist/conversation.ts: reusable reliable-intake instruction block.
- worker/receptionist/retell-config.ts: progress messages for coverage, availability, booking and callback; one retry for coverage, availability and idempotent callbacks; booking retries remain zero.
- worker/receptionist/live-probe.ts and scripts/receptionist-live-check.mjs: isolated, expiring, token-protected rollback test; retry only pre-execution 404 propagation responses. Test schema compatibility changes are rolled back.
- scripts/run-receptionist-postgres.mjs: dedicated local PostgreSQL runner with no production credentials.
- scripts/receptionist.test.mjs and scripts/receptionist-live-probe.test.mjs: regression coverage.

## Verification

- 137 receptionist tests passed against a dedicated local PostgreSQL cluster.
- 12 isolation/probe/phone-block tests passed.
- 9 MCP regression tests passed, including official SDK transport, authorization and concurrent booking.
- Modified routes/config TypeScript check and Worker dry-run bundle passed.
- Whole Worker typecheck still reports existing index.ts generic/type errors; it is not claimed clean.
- Cloud staging: signed ZIP checks, callback save/replay, booking/replay, notification outbox and rollback absence checks passed. Last route measurements: checkServiceArea 116 ms, requestCallback 115 ms, inside an already-open isolated database transaction. These are not end-to-end telephone latency measurements.
- No customer SMS/push was sent; no production test order was created. The temporary probe endpoint was removed and verified 404.
- No new Retell audio/simulation conversation was performed. Natural speech scenarios are protected by prompt rules and assertions, not claimed to be end-to-end voice-tested.

## Production and rollback

- Worker released: 5685069a-7b00-4ca4-8af8-86a2c1d53003, with all 66 live bindings retained.
- Worker rollback: f3467a3f-b1db-4934-9c95-989d89ce810a. Before bundle is in artifacts/worker-before.js.
- Phone agent V26, Reliable callbacks and waiting messages, published and assigned to +14632664687.
- Retell rollback: pin V25 on the same number.
- Greeting, initial 1 s pause, Cimo, speed 1.00, business policies, recording settings, phone routing and production schema were not changed.
- The failed real callback was not reconstructed or altered; the existing abandoned-call record remains.
- Remaining verification: a real caller conversation after release, and historical root-cause attribution if more server-side evidence becomes available.
