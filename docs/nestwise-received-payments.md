# All received payments are income immediately

Versioned migrations dated 2026-11-05 remove the completion/paid-parts delivery gate and update monthly cash statistics to schema 6. A valid recorded payment retains its actual received date regardless of Scheduled, Done, canceled or other job status. An invoice alone remains no payment. Existing pending event IDs and immutable facts are reused; source validation, corrections review, void/refund handling, leases and ordered delivery remain active. Automatic source materialization checks may drain valid job updates even while the job is open.

Release: backup CRM production; apply received-payments migration and statistics schema 6 transaction after CI; verify payment source totals and identifiers before/after; drain through the existing owner dispatch endpoint; confirm receiver ACK and November journal. Do not insert a replacement payment or mark a job Done. Existing realtime dispatch hooks continue running after payment writes.

Rollback SQL restores the prior functions and statistics definitions. It does not delete immutable events or reverse already received cash. Financial reversals require their real correction/refund evidence. Keep the schema-5 marker alongside schema 6 so previously deployed Workers do not reinstall the old projection.

Frontend wording must say all recorded payments by date received. The generated-web repository branch keeps current compiled features; do not replace it with an older source bundle. No new API access, credentials, integration channels or native dependencies are needed.
