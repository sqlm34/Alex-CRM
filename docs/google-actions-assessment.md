# Implementation assessment (2026-09-09)

## Existing and reusable

- Public React booking route `/booking`, anonymous session/risk checks and Worker
  job creation, Neon HTTP SQL and existing `waitUntil` tasks.
- PR #79 adds nullable `booking_source`, Google Maps/Google/Website labels and
  30-day browser attribution. This branch is stacked on that unmerged PR; its
  migration is a prerequisite, not permission to apply either migration.
- Main company website is `https://www.alex-repair.com`; its booking links currently
  point directly to `https://aleksappliancerepair.com/booking` without forwarding UTM.
  No changes to that external website are included.
- Production/preview Wrangler configs deliberately differ in R2 and Stripe flags.
  Preserve those values; new Google flags default OFF in both.

## Additions

- Early booking-domain token capture and 30-day persistence, protected server
  attribution and opaque browser handle, conversion outbox with bounded retries.
- Separate tiny Actions Center source detail, never raw tokens in jobs or notices.
- Offline current-schema feed generator, disabled upload and operational docs.
- Current robots file blocks every crawler. Inspect the official Google-Appointments
  crawler policy before adding a narrow booking-only allowance; retain CRM noindex.

## Approval and evidence limits

- Google partner approval, actual partner/merchant configuration, sandbox SFTP
  access, feed acceptance and production launch review are external prerequisites.
- Appointments Redirect is not Dining Business Link or end-to-end reservations.
- The documented conversion POST has no remote idempotency key. A lost response
  cannot establish exactly-once delivery; do not automatically resend ambiguous
  deliveries. Local leases and unique keys prevent concurrent/local duplicates.
- Existing source labels are best-effort; missing browser signals cannot prove
  organic versus paid Google traffic or distinguish direct from untagged referrals.
- No production config/data changes, Google feed uploads or conversion requests
  are part of this work. Synthetic tests are not Google sandbox certification.
