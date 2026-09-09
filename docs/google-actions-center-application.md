# Actions Center Application Draft

Status: truthful preparation draft only; not submitted. No partner acceptance, sandbox ingestion, launch approval, or Google UI placement is claimed.

Product: Alex CRM, our own booking platform for our own appliance repair business. Initial merchant count: 1. Country: United States. Requested integration: **Appointments Redirect**, Home Services / Appliance Repair, not Dining Business Link, not End-to-End booking, and not an asserted external merchant network.

Business website: https://www.alex-repair.com

Direct booking experience: https://aleksappliancerepair.com/booking

Customers should enter our existing CRM booking page directly from Google Search/Maps, complete booking there, and have the booking recorded by our own backend. We do not propose Setmore, Square, Calendly, or another hosted booking intermediary. The main website's existing Booking Now flow remains separate and unchanged. The two independent domains cannot share a normal first-party cookie; Google attribution belongs on the booking domain.

Parent's prior real-browser observation confirms that the main site's Booking Now link points directly to the booking URL without forwarding UTM; that external site is not modified. Parent's read-only booking HEAD request using `Google-Appointments` returned 200 text/html with noindex/nofollow headers, but this is not Google crawl/render acceptance. The existing blanket robots deny and a proposed narrow exception are assessed in the [crawler runbook](google-actions-feeds.md#crawler-check); retain CRM noindex and do not globally weaken WAF. The parent-owned [initial assessment](google-actions-assessment.md) records the broader implementation context.

Owner must provide: legal/operator name, contact and support details, exact Maps/Business Profile identity, phone, applicable address/service-area matching information, country/locale, service descriptions, verified landing links, immutable partner-managed entity/link/service IDs, brand assets, and privacy/cancellation/support policies. Do not substitute invented information or undocumented production identifiers.

Google must confirm: acceptance of this single-business first-party platform, account and category/geography eligibility, enabled action v2/entity/services schemas, service-area matching requirements where relevant, Sandbox Generic account access, partner ID, technical testing requirements, and production launch procedure.

[Current Appointments Redirect policy](https://developers.google.com/actions-center/verticals/appointments/redirect/policies/platform-policies), reviewed 2026-09-09, explicitly lists Appliance Repair under Home Services. That confirms category support, not acceptance of this applicant or a guaranteed blue Book / Book Online button. Matching, policy compliance, review and Google's presentation decisions remain prerequisites.

## Owner and Google Checklist

1. Apply for Actions Center and request Appointments Redirect for this actual one-merchant platform; accurately disclose present scale.
2. Obtain Google partner access and real partner ID; confirm feed schema versions and immutable merchant/entity mapping.
3. Confirm exact name, phone, website, address/service-area handling, category, country, locale and public bookability against the existing Maps listing. Do not edit Google Business Profile as part of this preparation.
4. Configure Sandbox Generic SFTP access with separate credentials and all three approved feed types.
5. Complete the private owner config and verify service-specific landing behavior. Generate offline feeds using the [feed runbook](google-actions-feeds.md).
6. Obtain separate authorization for sandbox upload, follow the descriptor-first runbook, resolve ingestion errors and verify merchant matching.
7. Exercise direct anonymous booking, crawler compatibility and Conversion Tracking v2 in sandbox; retain test evidence. Confirm attribution works without visiting the main website first.
8. Request Google review and explicit production approval. Receive real production credentials only after approval.
9. Separately authorize and review uploader/scheduler implementation, daily full refreshes, monitoring, and production conversion activation. None is activated by this draft or offline generator.
10. After approved launch, verify actual Book / Book Online presentation in Search/Maps. Do not promise its appearance in advance.

Preparation constraints: NOT DEPLOYED; NOT MERGED; NO PRODUCTION GOOGLE REQUESTS SENT; NO PRODUCTION FEEDS UPLOADED; GOOGLE BUSINESS PROFILE NOT MODIFIED. Actual sandbox validation remains blocked on credentials, approvals, owner data and authorized execution.
