# Receptionist owner routing and support release

## Production evidence

- Worker: `72ddc915-040a-4f69-95c1-98d67b62ea01`.
- Previous Worker: `51e419e1-4cc9-4352-bf89-592ff8ba677b`.
- Code-only release retained all 66 bindings and runtime/handler settings.
- Phone Retell V38, Owner SMS and excluded ZIP 46268, assigned to the existing inbound number. Tamsin and the 1-second initial pause were preserved.
- Website Retell V7 published. Existing web configuration uses latest_published; Cimo was preserved.
- Receptionist settings revision 4 -> 5 removed 46268 from all coverage groups. Other ZIPs and pricing unchanged.
- Additive support migration applied; no historical consent backfill or job updates.
- Frontend release commit: `553a457`; existing booking flag, CSS and old assets retained.

## Behavior

- New visits explicitly reject 46268, including ZIP+4 and spoken digits, even with stale approved coverage settings. Existing booking replays remain idempotent and existing jobs are not changed.
- Human requests immediately pause booking and offer texting Alex at 463-248-8429. A request for a person is not callback consent.
- Optional callback category distinguishes estimate copies, missed visits, customer callbacks and business solicitations. Solicitations have a separate CRM view.
- Confirmed callbacks deduplicate open issues with transactional locks and retain per-call context. Review rows upgrade in place with an original snapshot. Historical summaries never become verified consent automatically.
- Missed visits receive priority. Caller ID remains unsuitable for authorizing access to existing job information; no customer history is exposed.
- Exact signed Retell webhook endpoint accepts up to 1 MiB. Tool calls retain a 64 KiB cap. Limits count streamed bytes, signature verification precedes JSON parsing, and only whitelisted metadata persists.

## Verification

- Full receptionist/local PostgreSQL run: 145 passed, 0 failed.
- Focused MCP/ZIP suite: 16 passed after policy response filtering.
- Callback and phone-block suite: 7 passed.
- Webhook size/authentication suite: 6 passed.
- Financial/statistics regressions: 6 passed.
- Follow-up configuration tests: 4 passed.
- TypeScript, MCP TypeScript, production frontend build, Worker dry-run and diff checks passed.
- Retell text tests: Representative alone; request Alex during booking; same-number objection; spoken 46268 rejection. No appointment or callback was created in these read-only tests.
- Local synthetic CRM reviewed at 390px and 1000px. Customer callbacks and solicitations render separately with consent labels.
- Public production MCP checkServiceArea for 46268-1234 returns covered:false, zip_not_serviced, declineService. Production getBusinessPolicies returns 22 ZIPs without 46268.
- Debbie job J-MWKUM1L4-591A retained fingerprint `0305b38953409c9f02b7b79e482e04c2`, November 17, 3-5 PM, scheduled. No mutation or customer notification was sent.

## Provider findings and limits

Debbie call 07 provider logs show a first-token timeout at 15:28:27.664 UTC (2500 ms), followed by response 12 latency: end-to-end 7161 ms, ASR 633 ms, LLM 4610 ms, TTS 290 ms. There was no CRM tool invocation at the phone-dictation pause. Prompt guidance cannot guarantee elimination of a provider timeout; a fresh actual phone call was not made in this release.

The same call's call_ended and call_analyzed delivery attempts failed with HTTP 413. The bounded webhook increase addresses this failure class for future payloads. Old rejected events were not replayed.

No owner-approved overheating-specific wording was found. Existing immediate-danger guidance remains; no new hazardous repair advice was invented.

Authenticated voice lookup of existing jobs and automatic estimate delivery are not connected. Emily routes these requests to owner review/SMS or a consented categorized callback, without disclosing history or claiming delivery. Completed-callback versus resolved-issue reporting remains limited to the existing resolved state, not independently verified callback completion.

## Rollback

Restore the recorded previous Worker version to revert executable code while retaining bindings. The additive support columns and context table can remain; do not delete customer support history. Coverage removal and Retell versions are separate owner policy changes and must not be reverted accidentally with code. Frontend can restore the previous index asset reference without deleting new or historical assets.
