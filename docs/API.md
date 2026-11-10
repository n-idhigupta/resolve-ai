# REST contracts

Base `/api/v1`; strict Zod JSON objects reject unknown properties. IDs UUID; timestamps ISO UTC. Money `{minor:"2500",currency:"USD"}` uses bounded decimal integer strings. DTOs exclude secrets/internal notes/raw provider payloads. Generate OpenAPI during implementation.

## Common behavior

Success `{data:T,requestId}`; lists add `page:{nextCursor:string|null}`. Async 202 returns `{data:{operationId,state,statusUrl},requestId}`. Errors application/problem+json `{type,title,status,code,detail,requestId,errors?:[{path,message}]}`. 401 unauthenticated; 403 role/CSRF; 404 absent/inaccessible; 409 stale state or key/body conflict; 413 size; 422 schema/policy; 428 missing If-Match; 429 quota with Retry-After; 502 definitive upstream error; 503 dependency unavailable. Uncertain money remains a 202 durable operation, not a definitive failure.

Opaque session cookie: HttpOnly, Secure except localhost, SameSite=Lax, hashed server-side, 8h absolute/30m idle. Mutations require CSRF header and Origin validation; login validates Origin and rate limits. Argon2id passwords; seeded demo identities, no public registration. R=APPROVER/OWNER, A=AGENT/R, O=OWNER, C=customer ownership. Merchant path is not authorization; validate all nested parent/tenant IDs.

Idempotency-Key required for checkout/capture/case creation, proposal creation/counters/decisions/approval, refund execution and evidence completion. Scope merchant+actor+route+canonical body hash. Same key/body returns same resource; changed body 409. If-Match version required for aggregate mutations. Authorized exact replay checks prior result before stale-version rejection. Page default 25/max100; allowlisted sort/filter; date range max366 days; description max5000, comments max2000, JSON body max64KiB, webhook max256KiB.

## Auth and payments

| Endpoint                             | Request         | Response / authorization                                           |
| ------------------------------------ | --------------- | ------------------------------------------------------------------ |
| POST /auth/login                     | email,password  | 200 user,memberships,csrfToken + cookie; generic auth errors       |
| GET /auth/session                    | none            | 200 same bootstrap; authenticated                                  |
| POST /auth/logout                    | {}              | 204 revoke; authenticated/CSRF                                     |
| GET /orders                          | cursor          | 200 owned OrderSummary[]; C                                        |
| GET /orders/:orderId                 | none            | 200 OrderDetail; C or tenant A                                     |
| POST /orders/:orderId/checkout       | {}              | 202 operation; C; server selects totals/payee/URLs                 |
| POST /orders/:orderId/capture        | providerOrderId | 202 operation; C; must match persisted checkout                    |
| GET /payment-operations/:operationId | none            | 200 id,kind,state,providerOrderId?,approvalUrl?,errorCode?; C or A |
| GET /orders/:orderId/payments        | none            | 200 capture/refunds; C or A                                        |
| GET /merchants/:merchantId/orders    | cursor/filter   | 200 summaries; A                                                   |

OrderDetail={id,version,status,total:Money,items:[{description,quantity,unit:Money}],paymentStatus,activeCaseId?}. Orders are seeded/imported initially, not browser-priced. Worker creates PayPal order; browser polls for SDK order ID. Never accept browser capture ID or arbitrary redirect URL as payment truth.

## Cases and evidence

| Endpoint                                          | Request                                                          | Response / authorization                                    |
| ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| POST /cases                                       | orderId,reason,description,requestedOutcome                      | 201 CaseDTO; C, captured owned order                        |
| GET /cases                                        | cursor/status                                                    | 200 owned cases; C                                          |
| GET /cases/:caseId                                | none                                                             | 200 CaseDTO; C or A                                         |
| GET /merchants/:merchantId/cases                  | cursor/status/reason/assignee/age                                | 200 case summaries; A                                       |
| PATCH /merchants/:merchantId/cases/:caseId        | assigneeUserId?,action? ESCALATE/CLOSE_WITHOUT_AGREEMENT,reason? | 200 case; A, If-Match; no close during active refund        |
| POST /cases/:caseId/evidence/uploads              | filename,declaredType,sizeBytes,sha256                           | 201 evidenceId,uploadUrl,requiredHeaders,expiresAt; C or A  |
| POST /cases/:caseId/evidence/:evidenceId/complete | objectVersion                                                    | 202 scan operation; uploader or A; verify size/hash/version |
| GET /cases/:caseId/evidence                       | none                                                             | 200 metadata/states; C or A                                 |
| GET /cases/:caseId/evidence/:evidenceId/download  | none                                                             | 200 url,expiresAt; C or A, clean only                       |
| GET /cases/:caseId/timeline                       | cursor                                                           | 200 visible timeline; C filtered or A                       |

CaseDTO={id,orderId,status,version,policyVersionId,currentProposalId?,nextActions,createdAt,description}. Reasons ITEM_NOT_RECEIVED/NOT_AS_DESCRIBED/DAMAGED/DUPLICATE_CHARGE/OTHER; unauthorized-payment allegation requires human escalation. Requested outcomes FULL_REFUND/PARTIAL_REFUND/REPLACEMENT/HELP. Signed upload lasts5m to random immutable object key; signed download60s; no public ACL. Completion is not evidence cleanliness.

## Intelligence and negotiation

| Endpoint                                                                | Request                                 | Response / authorization                                                    |
| ----------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| POST /merchants/:merchantId/cases/:caseId/analyses                      | {}                                      | 202; A; dedupe snapshot+pipeline version                                    |
| GET /cases/:caseId/analyses/:analysisId                                 | none                                    | 200 findings/references/provenance/review reasons; A full, C published only |
| GET /merchants/:merchantId/policies                                     | none                                    | 200 versions; A                                                             |
| POST /merchants/:merchantId/policies                                    | effectiveFrom,clauses[{key,text,rules}] | 201 immutable version; O; strict rules                                      |
| GET /cases/:caseId/proposals                                            | none                                    | 200 versions; A drafts, C offered/history only                              |
| POST /merchants/:merchantId/cases/:caseId/proposals                     | kind,money?,terms,analysisId?,expiresAt | 201 DRAFT; A, If-Match case                                                 |
| POST /merchants/:merchantId/cases/:caseId/proposals/:proposalId/approve | contentHash                             | 200 OFFERED; R; exact immutable approval/publication                        |
| POST /cases/:caseId/proposals/:proposalId/decision                      | decision ACCEPT/REJECT,contentHash      | 200 proposal; C, current unexpired offer                                    |
| POST /cases/:caseId/proposals/:proposalId/counter                       | kind,money?,terms,reason                | 201 new DRAFT; C; supersedes prior unexecuted offer                         |
| POST /merchants/:merchantId/cases/:caseId/fulfillment                   | proposalId,shipmentReference            | 200 progress; A; accepted replacement only                                  |
| POST /cases/:caseId/receipt                                             | proposalId,received                     | 200 progress; C; false escalates, true completes acknowledged replacement   |

ProposalDTO={id,caseId,sequence,rowVersion,kind,money:null|Money,terms,policyVersionId,contentHash,expiresAt,status,explanation,policyChecks,requiredActions}. Terms discriminated by kind: refunds customerMessage; replacement itemDescription/shipBy; evidence request questions[]/dueAt; escalation reason. No executable fields. Expiry48h default/max7days; execution begins before expiry. Actor derives from session. Case lock and If-Match serialize draft/counter/approval/decision.

## Refunds, audit and analytics

| Endpoint                                                | Request                        | Response / authorization                                             |
| ------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| POST /merchants/:merchantId/cases/:caseId/refunds       | proposalId                     | 202 RefundDTO; R, login within15m, current agreement, If-Match case  |
| GET /cases/:caseId/refunds/:refundId                    | none                           | 200 RefundDTO; C or A                                                |
| POST /merchants/:merchantId/refunds/:refundId/reconcile | {}                             | 202 read/reconcile job; R; cannot force success/change key           |
| GET /merchants/:merchantId/analytics                    | from,to query                  | 200 metrics,definitions,currency buckets,asOf; A                     |
| GET /merchants/:merchantId/cases/:caseId/audit          | cursor                         | 200 redacted AuditEvent[]; A                                         |
| POST /webhooks/paypal/:accountKey                       | original body + PayPal headers | 202 only after durable inbox; no session/CSRF, verify before effects |

RefundDTO={id,proposalId,state,money,providerRefundId?,createdAt,updatedAt,nextAction}. State READY/IN_FLIGHT/PENDING/UNKNOWN/COMPLETED/FAILED. No retry button creates a new intent. accountKey is nonsecret routing configuration, not authentication. Raw receipt acknowledgment is not signature acceptance.

Formal dispute APIs excluded P0. Future merchant formal-disputes read/sync requires entitlement and R. Design action endpoints only after actual provider permission/state/capability verification; never map internal case actions automatically.

## Analytics definitions

Use UTC half-open [from,to) ranges and return asOf. Case incidence is distinct orders with a case opened in range divided by distinct captured orders completed in range; label it an operational ratio because numerator and denominator cohorts differ, not a probability or prevention rate. Also provide capture-cohort complaint rate: captured orders in range that have a case by asOf divided by captured orders in range, with observation cutoff stated. Resolution duration uses resolved cases whose resolved_at lies in range, measured from opened_at to resolved_at; show median/p95 and sample count. Outcome counts use fulfilled proposals completed in range, one outcome per resolved case. Refund totals sum completed local plus verified external refunds with completed_at in range, grouped by currency and deduplicated provider refund ID. Pending/unknown totals are separate exposure metrics. Never mix currencies or equate internal cases with chargebacks. Store case resolved_at and operation completed_at explicitly in migrations; these fields are required for reproducible reporting.

## Phase 2 implemented subset

Only /health, /ready, auth login/session/logout, customer order list/detail and merchant order list are implemented. Other endpoints above remain design contracts. Order lists use UUID keyset cursors and limit (default25/max100) in this foundation release; future timestamp+ID paging requires an explicit contract update. Order detail includes a non-sensitive merchantId. No payment mutations are exposed. API errors use application/problem+json; readiness is a minimal dependency-status response.

## Phase 3 implemented checkout contracts

All paths below include the existing /api/v1 prefix. Existing auth/read-only order routes remain. Customer writes require session ownership, trusted Origin, x-csrf-token, Idempotency-Key (1-128 chars), and numeric quoted/unquoted If-Match order version. Exact authorized replay is resolved before stale-version checks. Unknown body properties, including client money/payee fields, fail validation.

| Endpoint                             | Body / result                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /paypal/config                   | Authenticated; enabled, sandbox environment, public clientId, USD currency and fixed official SDK URL. No secret/token/database URL.                                                                 |
| POST /orders/:orderId/checkout       | {}; 202 existing/new immutable CREATE operation. Item totals/currency/merchant checked server-side.                                                                                                  |
| POST /orders/:orderId/capture        | {providerOrderId}; 202 existing/new CAPTURE operation. ID must match that owned order's persisted provider association; GET approval proof is mandatory before execution.                            |
| GET /payment-operations/:operationId | Customer owner or scoped merchant; safe operation status/provider IDs/error code/status URL.                                                                                                         |
| GET /orders/:orderId/payments        | Customer owner or scoped merchant; orderId, payment status, version, money, safe operation summaries and verified capture metadata.                                                                  |
| POST /webhooks/paypal/:accountKey    | Public raw JSON <=256KiB plus five PayPal transmission/certificate/algorithm headers; 202 only after encrypted receipt/inbox/outbox commit. No session/CSRF exemption applies to customer mutations. |

Payment progress: NOT_STARTED -> PENDING/CREATED -> AWAITING_BUYER_APPROVAL -> APPROVED -> CAPTURE_PENDING -> CAPTURED. Worker transactions can coalesce intermediate states; observed transitions are audited. FAILED/CANCELLED are terminal workflow outcomes; unknown outcomes enter RECONCILIATION_REQUIRED and may recover through verified provider reads. Browser popup cancellation is advisory and never asserts provider cancellation. Later verified settlement changes freeze existing captured metadata for review rather than allowing another payment.

Idempotency hash conflicts return409; nonpayable/already-paid orders409; missing version428; totals/currency/schema422; disabled/unconfigured Sandbox503; unauthorized resource404/401. Asynchronous unknown states return durable operations, never fake payment success. Pending capture details are not a verified Capture record. Refund/AI/complaint/formal-dispute endpoints are still unimplemented.

## Phase 4 implemented contracts (supersedes planned case/evidence rows above)

All paths use /api/v1. Complaint reasons include INCORRECT_AMOUNT. POST /cases requires orderId, reason, title, description, requestedOutcome and optional desiredResolution. GET /orders/:orderId/complaint-eligibility?reason=? returns eligibility/blocking/review reasons, legacy-policy status and repeat limits. GET /cases and GET /merchants/:merchantId/cases use cursor/limit/status/reason/orderId/search/from/to/sort=newest|oldest; date ranges are UTC and bounded. Case detail includes safe order/capture metadata and the first discussion/timeline page plus evidence metadata to bound polling requests.

POST /cases/:caseId/actions allows RESPOND/WITHDRAW for customers; POST /merchants/:merchantId/cases/:caseId/actions permits BEGIN_REVIEW/REQUEST_INFORMATION/CLOSE_WITHOUT_AGREEMENT for merchant roles. Mutations require If-Match and Idempotency-Key. Messages are required except for BEGIN_REVIEW. POST /cases/:caseId/comments accepts body and visibility CUSTOMER|INTERNAL; only merchant actors may use INTERNAL. GET comments/timeline/evidence routes are paginated with chronological UUID cursors.

POST /cases/:caseId/evidence/uploads accepts filename,declaredType,sizeBytes,sha256 and returns id/expiry plus transport metadata. PUT /cases/:caseId/evidence/:evidenceId/content requires application/octet-stream and exact declared size/hash. No public/presigned upload is exposed. POST complete accepts {}, expected case version and idempotency key, returning 202 queued evidence. GET download returns an authorized attachment, not a signed URL, and rejects unavailable evidence.

Merchant policies: GET/POST /merchants/:merchantId/policies/drafts; PUT drafts/:draftId with If-Match; POST drafts/:draftId/validate and /publish; GET versions and versions/:versionId. OWNER manages drafts/publication; merchant roles may read published versions. Strict document contract is exported from shared. No policy endpoint executes money.

## Phase 5 implemented contracts

All paths below start /api/v1, require a verified session, and return the existing {data,requestId} envelope or structured problem. Mutations require Origin + session-bound CSRF; request/review operations require Idempotency-Key. Source IDs are case-local aliases, not URLs. Amounts serialize as decimal minor-unit strings.

| Method/path                                                                     | Contract and permission                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET /ai/config                                                                  | Authenticated safe enablement/model/disclosure flags                                                                       |
| GET /merchants/:merchantId/ai-sharing-policies                                  | Own scoped policy history; enabled/model/sequence/hash/dailyBudgetMicros                                                   |
| POST /merchants/:merchantId/ai-sharing-policies                                 | OWNER only; strict {enabled,modelId,dailyBudgetMicros}; new immutable version                                              |
| POST /cases/:caseId/ai-sharing-previews                                         | Owner customer or scoped merchant; {evidenceIds:UUID[]} max10; idempotency; 202 {id,state}; asynchronous local preparation |
| GET /cases/:caseId/ai-sharing-previews/:contextId                               | Authorized case; exact encrypted-at-rest request decrypted only for preview, policy/disclosure/consentHash/expiry/state    |
| GET /cases/:caseId/ai-consents                                                  | Authorized case; own scoped consent/revocation history                                                                     |
| POST /cases/:caseId/ai-consents                                                 | Case customer only; {contextId,sharingPolicyId,consentHash}; exact READY/current preview required                          |
| POST /cases/:caseId/ai-consents/:consentId/revoke                               | Consenting customer only; {}; append revocation                                                                            |
| POST /merchants/:merchantId/cases/:caseId/analyses                              | Scoped merchant, If-Match case version; {consentId}; 202 immutable queued snapshot                                         |
| GET /merchants/:merchantId/cases/:caseId/analyses                               | Merchant-only history; limit1..100 default25, optional UUID cursor                                                         |
| GET /merchants/:merchantId/cases/:caseId/analyses/:analysisId                   | Merchant-only status, validated output, server facts, candidate constraints, versions, usage and reviews                   |
| GET /merchants/:merchantId/cases/:caseId/analyses/:analysisId/sources/:sourceId | Merchant-only catalog-resolved excerpt/page/hash; blocked after consent revocation                                         |
| POST /merchants/:merchantId/cases/:caseId/analyses/:analysisId/reviews          | If-Match analysis version; {action:APPROVE/REJECT/REVISE,reason,candidateId:string                                         | null,rationale}; OWNER/APPROVER approve/revise, member reject |
| GET /merchants/:merchantId/ai-usage                                             | Merchant-only daily committed micro-USD and recent bounded attempt history; estimated, not an invoice                      |

Strict output schema: packages/shared/src/ai.ts. Recommendation contains only server candidateId and concise rationale/finding/source IDs. Financial amounts are never accepted from model or review clients. Stale, revoked or invalid recommendations cannot be approved/revised. No analysis route creates offers, changes case state or performs payments. Disabled inference returns 503; stale/consent/policy conflicts 409, wrong versions conflict, missing If-Match 428, invalid input422, inaccessible resources404. Customer analysis access returns404. See AI-DESIGN.md.

## Gemini provider selection and consent

GET /api/v1/ai/config now reports provider, model, syntheticOnly and provider-specific disclosure without a key. Configuration enablement is not proof of live worker/provider health. Sharing-policy creation accepts either reviewed model; stored providerId is inferred and constrained by SQL. Switching providers requires a new immutable policy and customer consent.

Google preview responses include providerId, providerRequest and tokenCountRequest: the exact deterministic SDK arguments (authentication excluded). The existing normalized request remains for pipeline compatibility; its internal store:false marker is not a Google retention control. Unmarked or changed synthetic cases fail with GEMINI_SYNTHETIC_CASE_REQUIRED. There is no customer/merchant endpoint to mark cases synthetic. See GEMINI.md for unpaid restrictions.

## Phase 6 milestone A implemented negotiation API

These contracts supersede the earlier proposal design table for milestone A only. Existing case comments/timeline provide customer/merchant negotiation discussion, with INTERNAL notes restricted to merchant actors. No ACCEPT, settlement authorization or refund execution endpoint is implemented.

- GET /api/v1/cases/:caseId/proposals?limit=25&cursor=SEQUENCE returns data {items,nextCursor,caseVersion}. Customer sees only published history/own counters; tenant merchants see drafts. DTO includes exact contentHash, immutable terms, authorship, sequence, rowVersion, expiresAt, status/effectiveStatus, stale, caseVersion, nonbinding=true, acceptanceAvailable=false. Merchant-only policyChecks are omitted for customers.
- POST /api/v1/merchants/:merchantId/cases/:caseId/proposals creates immutable DRAFT (201), AGENT/OWNER/APPROVER. Input discriminated by kind: FULL_REFUND/PARTIAL_REFUND {amountMinor:decimalString,currency:USD,message,expiresAt}; REPLACEMENT {message,itemDescription,shipBy,expiresAt}; REQUEST_EVIDENCE {message,questions:string[],expiresAt}; ESCALATION {message,expiresAt}. Unknown properties fail. Expiry required, future and at most seven days.
- POST /api/v1/cases/:caseId/proposals/:proposalId/counter uses the same strict terms; owning customer only, current unexpired/context-current OFFERED parent. Creates new DRAFT and supersedes parent atomically. Counter is a request, not customer acceptance or merchant authorization.
- POST /api/v1/cases/:caseId/proposals/:proposalId/actions accepts {action:PUBLISH|REJECT|WITHDRAW|EXPIRE,contentHash:sha256,reason:string}. PUBLISH requires OWNER/APPROVER and a current-context merchant DRAFT; financial/policy checks rerun. Merchant drafts are not editable: create a new version. Customer counter publication requires a separate reviewed merchant draft. REJECT/WITHDRAW/EXPIRE follow PHASE-6-A-REPORT.md permissions.

Mutations require trusted Origin, session-bound CSRF, Idempotency-Key and case If-Match. Missing/malformed version428, wrong version/hash/state409, policy/input422, permission403, inaccessible resource404. Publication does not create a financial authorization; no Approval/RefundOperation, reservation or execution job exists in A. Expiry is enforced without waiting for background work, with explicit EXPIRE to persist timeline. See packages/shared/src/negotiation.ts and PHASE-6-A-REPORT.md.

## Phase 6 B-D implemented contracts

All routes retain session ownership/merchant scoping and Origin/CSRF; writes require case If-Match and Idempotency-Key. GET /cases/:caseId/settlements returns safe status/refund/reference/shipment metadata. POST /cases/:caseId/proposals/:proposalId/accept and POST /cases/:caseId/settlements/:settlementId/authorize accept strict {contentHash,proposalVersion,confirm:true}. Acceptance is customer-only, current unexpired merchant offer; authorization is OWNER/APPROVER with authentication within 15 minutes and revalidates policy/freshness/balance. Authorization and reservation/outbox are atomic. POST settlements/:settlementId/cancel {reason} cancels only an unexecuted acceptance. POST settlements/:settlementId/reconcile {} schedules existing UNKNOWN/PENDING lookup, never a new intent. POST settlements/:settlementId/fulfillment {action:SHIP|RECEIVE,reference?} records merchant shipment/customer receipt for replacements, without a refund.

Disabled real-refund configuration returns 503. Synthetic mock execution requires a migration-authorized mock account and SYNTHETIC_ capture. No browser-provided capture, amount or provider identifier may override accepted immutable terms. The customer/merchant UI uses these routes and explicit exact-version confirmations. Published merchant terms and nonbinding internal AI reviews remain distinct from financial authorization.

## Phase 7 analytics

`GET /api/v1/merchants/:merchantId/analytics?from=<UTC ISO>&to=<UTC ISO>` requires an authenticated active merchant member. Nonmembers receive 404. Strict filters allow at most 366 days; the end is exclusive and capped at server time. The response is validated by `packages/shared/src/analytics.ts`. Monetary aggregates are decimal minor-unit strings, rates are integer basis points (null for empty denominators), durations are hours with sample counts. Definitions describe distinct case-opened, resolved-time, settlement-accepted and refund-completed cohorts. Pending/UNKNOWN exposure is current across all dates. The endpoint is read-only and uses a tenant-scoped repeatable-read snapshot; AI approval never counts as payment authorization.

Merchant case listings additionally return aiReview (null or status/stale/revoked), derived from the latest case analysis inside the existing tenant transaction and FORCE RLS. Customer listings omit this merchant-only summary. It is review metadata, never an inferred risk score, approval or financial authorization. No new endpoint or migration is required for the Community grid.
