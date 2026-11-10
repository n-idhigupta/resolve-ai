# Product requirements

## Scope and roles

Customers need transparent complaint handling; merchants need traceable evidence-to-payment decisions. CUSTOMER owns orders/cases; AGENT investigates; APPROVER authorizes remedies; OWNER manages policies/memberships and may approve. Agent role alone never authorizes refunds.

P0: Sandbox checkout/capture, complaints, private evidence, cited AI findings, deterministic policy, versioned negotiation, two-party consent, partial/full refunds, recovery, audit and merchant analytics. P1: manual replacement fulfillment and evidence requests; entitled formal-dispute read/sync. Excluded: live funds, FX, split captures, autonomous refunds, marketplace onboarding and legal adjudication.

## Acceptance criteria

| ID  | Requirement  | Acceptance                                                                                                                 |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| P01 | Checkout     | Server-owned amount; verify capture amount/currency/payee/order; browser cannot mark paid.                                 |
| P02 | Complaint    | Owned captured order; idempotent create, one active case/order, purchase-policy snapshot.                                  |
| P03 | Evidence     | JPEG/PNG/text PDF, max 10 MiB/file and 10 files/case; quarantine until scan/type/hash checks; authorized downloads only.   |
| P04 | Intelligence | Supported findings have validated source coordinates; contradictions/missing facts visible; manual fallback on AI failure. |
| P05 | Policy       | Deterministic checks block invalid money/currency/evidence/expiry; no model override.                                      |
| P06 | Negotiation  | Immutable versions; counter supersedes offer and requires renewed approval; stale mutation is 409.                         |
| P07 | Refund       | Same current version has both consents; repeated execution yields one operation; uncertainty retains reservation.          |
| P08 | Recovery     | Worker death after provider call, duplicate webhooks and Redis loss converge safely.                                       |
| P09 | Audit        | Evidence/policy/analysis/proposal/consents/payment linked; customer sees filtered timeline.                                |
| P10 | Dashboard    | Community AG Grid filters/sort/paging, accessible details, no cross-tenant access.                                         |
| P11 | Analytics    | Completed refunds by currency, cases per captured orders, outcomes and resolution time; no chargebacks-prevented claim.    |
| P12 | Security     | Injection cannot authorize money; forged events/other tenants cannot affect balances.                                      |

## Screens

| Screen             | Workflow                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Customer dashboard | Owned orders/cases, pending decisions and refunds.                                                    |
| Order details      | Items, money, capture history; checkout or complain.                                                  |
| Complaint wizard   | Reason, description 20-5000 chars, desired remedy, upload, confirmation.                              |
| Evidence upload    | Progress, quarantine/scan/extraction and correction.                                                  |
| Case tracker       | Timeline, next action, missing information, offer and expiry.                                         |
| Findings explorer  | Finding beside cited source, trust class and uncertainty.                                             |
| Negotiation        | Version comparison, terms, accept/reject/counter.                                                     |
| Merchant cases     | AG Grid Community server filters/paging, age/assignee, detail drawer.                                 |
| Merchant review    | Verified payment, evidence, policy, suggestions; draft/request information/escalate.                  |
| Refund approval    | Exact amount/destination capture, both consents, expiry; explicit execute and pending/unknown status. |
| Payment history    | Captures/refunds, safe provider IDs and reconciliation states.                                        |
| Analytics          | Currency-specific totals, cohorts, outcomes, resolution-time definitions.                             |

Neutral fintech surfaces, clear typography/status chips, responsive customer flow, desktop merchant workspace. Target WCAG 2.2 AA. Loading/empty/denied/stale/offline/provider-failure states, keyboard support and no color-only meaning. Persistent Sandbox banner. Backend idempotency remains authoritative. Show concise explanations, never hidden chain-of-thought.

Targets, not measurements: API p95 <500ms excluding external calls/uploads, small-case analysis <60s with 90s deadline, durable webhook receipt <2s. No availability SLA for initial single-region deployment.

Assumptions: English synthetic evidence, reachable Sandbox and configured seller. Merchant policy is not legal adjudication. Resolve jurisdictions, retention/erasure, identity, seller permissions and replacement logistics before real use.

## Phase 4 scope clarification

Support all six categories including incorrect amount. Preserve one active case per order; cap lifetime complaints at three with a 24h cooldown after closure. Closed without agreement means nonfinancial closure, never a settlement/refund. Legacy purchase policies with no clauses permit human-reviewed intake with an explicit UI/audit notice. An optional ClamAV profile supports the evidence demo; unavailable scans never produce clean/downloadable evidence.
