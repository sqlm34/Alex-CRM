# Google Appointments Redirect Offline Feeds

## Assessment and evidence

Reviewed official Google documentation on 2026-09-09 before implementation. Existing `src/App.tsx` recognizes `/booking` and offers appliance repair services; `scripts/*.test.mjs` uses Node's built-in test runner. No existing feed generator was found. This module reuses those conventions without changing booking, package scripts, backend, deployment configuration, or business profile data.

- [Feed requirements](https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/feeds): entity, action and services are mandatory daily full refreshes, uploaded to Sandbox first.
- [Entity schema](https://developers.google.com/actions-center/verticals/appointments/redirect/reference/feeds/entity-feed): partner-assigned immutable entity ID, matching name and location. Telephone and website are recommended by Google; this implementation requires both and a US structured address as a stricter owner-data gate. No address or coordinates are inferred.
- [Action v2 schema](https://developers.google.com/actions-center/verticals/appointments/redirect/reference/feeds/action-feed): `actions: [{ "appointment_info": {} }]`. Do not add legacy `ACTION_LINK_TYPE_BOOK_APPOINTMENT` or Dining Business Link fields. Ask Google to confirm the enabled version.
- [Services schema](https://developers.google.com/actions-center/verticals/appointments/redirect/reference/feeds/services-feed): merchant/service IDs, localized name/category, price and duration interpretation. This bounded implementation only supports explicitly undisplayed price/duration, never invented prices or zero-duration promises. It provides a service action URL, with owner confirmation that the landing page selects that service.
- [Generic SFTP](https://developers.google.com/actions-center/verticals/appointments/redirect/reference/tutorials/generic-sftp): approval for each feed type; descriptor first, then its data files. This is not the legacy Merchants/Services/Availability SFTP account.

## Configuration and generation

The initial runtime has one configured merchant. Generation therefore rejects more
than one merchant, even with distinct IDs, rather than sending multiple entities to
the same single-merchant booking configuration. The database model can be extended
to multiple locations without destructive migration; mapping/routing needs review.

Use `config/google-actions-feeds.example.json` as the shape for a private owner-reviewed config outside git. Its placeholders deliberately fail. Replace all TODO values; set the two confirmations only after checking actual owner data and Google-enabled schemas. Google partner ID is an onboarding gate, not an emitted feed field. Entity/link/service IDs are assigned and retained by the partner, not Google Place IDs; agree their identity mapping during onboarding. Use the same entity ID for backend conversion merchant association.

Keep `merchantWebsite = https://www.alex-repair.com` and `bookingActionUrl = https://aleksappliancerepair.com/booking` distinct. Service URLs must use that booking origin/path, may contain verified service-selection query parameters, and must never contain `rwg_token`. No URL is fetched by the generator. The current form's existence alone does not prove service preselection: leave `landingPageVerified` false until tested. A generic landing URL is only appropriate if it genuinely represents the configured service; do not publish several specific services all pointing to an unselected picker.

The initial supported configuration is US structured addresses and undisplayed pricing/duration. Hidden-address/service-area businesses must obtain Google's matching guidance; never invent a storefront to satisfy this validator. Other countries, coordinate-only entities, prices/ranges, gzip, sharding, and service routing changes require a separate reviewed extension. Merchant and service array order is preserved deliberately; identical input and timestamp produce identical bytes.

Run from the repository (PowerShell; existing parent directory, new output leaf):

```powershell
node scripts/google-actions-feeds.mjs --config C:/private/google-actions-owner.json --out C:/private/google-actions-sandbox-run --timestamp 1788912000
node --test scripts/google-actions-feeds.test.mjs
```

The timestamp above is illustrative. Supply the actual generation time in Unix seconds for a separately approved upload, with a fresh timestamp and filenames for each batch. No implicit current time or output directory is used. Validation finishes before writes. Existing output directories, relative output paths, and paths resolving within the repository are rejected. An IO failure can leave a partial directory: discard it manually and regenerate to a new directory; never upload a partial batch.

Exports: `validateConfig(config)`, `generateFeeds(config, generationTimestamp)` (filename-to-JSON-string object), `writeFeeds(config, generationTimestamp, outputDirectory)` (async), `main(args)` (async), `MERCHANT_WEBSITE`, `BOOKING_ACTION_URL`.

Parent-owned package entry: `"google-actions:generate-feeds": "node scripts/google-actions-feeds.mjs"`. The existing test glob includes the new test automatically. All CLI flags are required: `--config`, `--out`, `--timestamp`; unknown flags fail, including upload/schedule flags. Production config is rejected. Runtime Google/conversion feature flags do not enable this tool's networking: there is none.

## Approved Sandbox SFTP Runbook

These are manual future steps, NOT performed or validated against Google in this task. They require owner authorization, Google partner access, approval for all three feed types, Sandbox Generic username, registered SSH public key, and a securely held private key. Never commit keys or credentials. The Sandbox selector and account username, not the hostname alone, distinguish the environment.

1. In Partner Portal select **Sandbox**, then **Configuration > Feeds > Generic**. Confirm account/environment with Google; verify the server host key through a trusted Google/onboarding channel. Do not disable host-key checks or use production credentials.
2. Review the generated files locally and verify every descriptor's `data_file` exists. Obtain explicit approval for this sandbox batch; do not upload the unresolved example or synthetic test fixture.
3. Connect using OpenSSH (replace the uppercase placeholders outside git):

```text
sftp -o StrictHostKeyChecking=yes -i PRIVATE_KEY_PATH -P 19321 SANDBOX_GENERIC_USERNAME@partnerupload.google.com
lcd C:/private/google-actions-sandbox-run
put reservewithgoogle.entity-TIMESTAMP.filesetdesc.json
put reservewithgoogle.entity-TIMESTAMP_0001.json
put reservewithgoogle.action.v2-TIMESTAMP.filesetdesc.json
put reservewithgoogle.action.v2-TIMESTAMP_0001.json
put glam.service.v0-TIMESTAMP.filesetdesc.json
put glam.service.v0-TIMESTAMP_0001.json
bye
```

4. Use the actual generated timestamp in all six names. Upload at the Generic dropbox root; descriptors precede their corresponding data files. No wildcard uploads, altered remote filenames, or cross-environment batches.
5. In Sandbox **Ingestion > History** (also referenced as **Feeds > History**), inspect each of the three feed names. Resolve all errors/warnings, verify merchant matching in inventory, and retain Google review evidence. A local passing test is not Google ingestion or merchant-match validation.
6. Test direct anonymous booking, service selection and sandbox Conversion Tracking v2 through the separately implemented backend. Obtain Google confirmation before any production rollout.

## Upload and Scheduling Limitations

There is no uploader, SFTP client dependency, credential reader, cron registration, or scheduling implementation. Daily refresh is a documented operational requirement, not a running job. A future approved uploader must separate environment credentials, validate the complete batch, verify host keys, upload descriptors before data, monitor ingestion, and implement bounded retry without filename reuse. Production activation requires separate owner authorization, Google sandbox acceptance and launch approval, real production credentials, reviewed uploader/scheduler implementation, then explicit production feed and conversion activation. This generator intentionally cannot activate production.

## Crawler Check

Parent's read-only observation on 2026-09-09: HEAD of the actual booking URL with `User-Agent: Google-Appointments` returned `200` and `text/html`, with `X-Robots-Tag: noindex,nofollow,...`. The existing repository `public/robots.txt` disallows `/` for all bots. This proves that this HEAD request was reachable, not that Google fetched robots.txt, performed GET, rendered the SPA, or accepted the action link. Parent also previously observed the main site's Booking Now link in a real browser: direct to the booking URL, without UTM forwarding. No edits to that site are included. See the parent-owned [initial assessment](google-actions-assessment.md).

### Narrow robots exception evidence

The [Appointments monitoring guide](https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/post-launch-monitoring), updated 2026-08-24, identifies both `Google-Appointments` and standard Googlebot user agents for link verification. It does not explicitly document whether `Google-Appointments` honors robots.txt, its REP product-token matching, or how it interprets `noindex`/`nofollow`. Do not claim those crawler-specific behaviors as confirmed; ask the Google onboarding contact. Googlebot-only Search Console testing cannot prove the other crawler's behavior.

Google's [REP specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec) documents automated crawler robots handling, most-specific user-agent groups, longest matching paths, and query-string matching. Its [narrow-access examples](https://developers.google.com/crawling/docs/robots-txt/useful-robots-txt-rules) show crawler-specific exceptions while retaining a wildcard deny. Based on those general rules, the parent may prepare the following conservative booking-only policy; this is a proposed configuration, not verified Google-Appointments behavior:

```text
User-agent: Google-Appointments
User-agent: Googlebot
Disallow: /
Allow: /booking$
Allow: /booking?
Allow: /booking/$
Allow: /booking/?

User-agent: *
Disallow: /
```

The query forms permit attribution/service parameters; anchored exact paths avoid unintentionally allowing `/booking-admin` or unrelated nested routes. The slash forms cover the existing normalized booking route. Retain the explicit deny inside the named group: the wildcard group's rules are not inherited. This changes crawler permissions only, not HTTP authentication or WAF policy. Parent owns any robots change; this subtask edits documentation only.

Keep CRM `noindex` headers/meta and authenticated access controls. [Google's robots introduction](https://developers.google.com/search/docs/crawling-indexing/robots/intro) distinguishes crawl permission from indexing: disallowed URLs can still be listed, and a blocked crawler cannot read a page's noindex directive. A narrow booking allowance is not permission to index the CRM or weaken security. This candidate still blocks JS/CSS resources and API routes, which may prevent full SPA rendering; verify with authorized live rendering and Google guidance before proposing any additional exact resource allowances. Do not silently broaden access to `/assets/`, `/api/`, or the entire site, remove noindex, or bypass WAF based solely on a spoofable user agent.

[Google post-launch monitoring](https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/post-launch-monitoring) documents a User-Agent containing `Google-Appointments`; inaccessible 4xx/5xx links may be disabled. Parent/backend verification must check anonymous `/booking` GET with the full crawler-style agent, SPA fallback and query preservation, plus deployed CDN/WAF/robots/auth/rate limits after separately authorized access. Test both the direct booking URL and each service URL, with no prerequisite main-site visit. A spoofable User-Agent is not authentication: do not globally bypass security or protect booking POSTs less strongly. Offline tests cannot certify deployed Cloudflare behavior. No live crawler or sandbox validation is claimed here.
