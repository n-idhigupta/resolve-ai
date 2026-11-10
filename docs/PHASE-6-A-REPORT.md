# Phase 6 milestone A: negotiation domain and APIs

Status: milestone A implemented and verified locally; ready for review. Milestones B (settlement), C (refund execution/reconciliation), and D (frontend) require separate review before work proceeds. Phase 5 real Gemini output remains unverified and is unrelated to this milestone.

## Repository decisions

Reuse CaseStore tenant transactions, session/Origin/CSRF checks, immutable CaseComment/CaseTimelineEvent/AuditEvent, Proposal, canonical hashing and permanent actor-scoped IdempotencyRecord. Published purchase-policy snapshots remain authoritative; current merchant policy edits do not change cases. Existing AI analyses remain merchant-only nonbinding reference material; no new provider request or automatic draft generation is added in A. Humans author every proposal. Negotiation messages use existing customer-visible case comments; private merchant notes retain their existing API/RLS separation.

The older roadmap describes safe refunds as Phase 7. The requested delivery now groups negotiation and eventual refunds into Phase 6 A-D. Only A is authorized now. The original approval/customer acceptance endpoints are design contracts, not implemented settlement capabilities.

## Domain and permissions

| Operation                       | Customer owning case                      | AGENT                           | OWNER/APPROVER       |
| ------------------------------- | ----------------------------------------- | ------------------------------- | -------------------- |
| Read history                    | Published offers and own counters         | Tenant history including drafts | Same                 |
| Create merchant draft           | No                                        | Yes                             | Yes                  |
| Publish merchant draft          | No                                        | No                              | Yes                  |
| Counter current unexpired offer | Yes; new immutable DRAFT supersedes offer | No                              | No                   |
| Reject                          | Current OFFERED merchant proposal         | Customer counter                | Customer counter     |
| Withdraw                        | Own counter                               | Merchant draft/offer            | Merchant draft/offer |
| Persist expiry                  | Visible expired DRAFT/OFFERED             | Visible expired DRAFT/OFFERED   | Same                 |
| Accept / authorize settlement   | Unavailable in A                          | Unavailable                     | Unavailable          |

DRAFT ? OFFERED (approver publication); DRAFT/OFFERED ? WITHDRAWN or EXPIRED; OFFERED ? REJECTED or SUPERSEDED by a counter/new publication; customer counter DRAFT ? REJECTED/WITHDRAWN/EXPIRED. Customer counters cannot be published directly: merchant creates a new reviewed draft. Terminal versions cannot reopen. Existing AGREED/EXECUTING/FULFILLED fixtures remain untouched; A never enters those states. No Approval row, financial reservation, outbox execution event or RefundOperation is created.

All writes require numeric case If-Match, Idempotency-Key, session CSRF and trusted Origin. Case row lock serializes negotiation actions. Exact authorized replay precedes stale-version checking. Changed intent conflicts. Offer content hashes bind terms, expiry, case/order, policy, sequence, author, supersession and source context. Client status/author/amount execution fields are rejected.

Expiry is authoritative at read/action time without a worker: responses show effectiveStatus=EXPIRED immediately; an explicit EXPIRE action persists status/timeline. No expiry execution job exists in A. Default UX expiry is deferred to D; API requires an explicit future expiry within seven days. History is sequence-paginated (25 default, 100 maximum).

## Additive migrations

0023_negotiation adds immutable authorship/context/policy-check metadata, WITHDRAWN, and append-only ProposalPublication with FORCE RLS. Publication receipts distinguish ever-published versions from withdrawn private drafts. Existing same-case supersession constraint is reused. Legacy proposal rows keep nullable new fields; no payment/capture rows are rewritten. Negotiation runtime grants are restricted to insert and lifecycle columns; immutable-content and transition triggers deny settlement states. AI/payment/evidence workers receive no negotiation write permissions.

A fixed-scope SECURITY DEFINER sequence lookup sees hidden drafts only to return the next case-local integer. It validates tenant plus case ownership/membership, exposes no contents, has fixed search_path, and is executable only by runtime roles. The API holds the case lock before calling it. 0024_negotiation_offer_guard adds a partial unique index enforcing at most one OFFERED proposal per case. Application checks supplement SQL/RLS.

Staleness hashes bind case status/revision, immutable policy snapshot, verified capture identity/status/balance/version, evidence hashes/states, and customer-visible discussion. Negotiation-only version increments do not invalidate their own context. Private notes are excluded. Material discussion/evidence/payment changes block publication/countering; closed cases block new negotiation. History remains readable after financial reconciliation freezes. B must revalidate all terms, freshness, policy and refundable balance at agreement/authorization/reservation; an A offer reserves no funds.

Legacy/missing/ambiguous policy permits information requests or human escalation only, not invented financial entitlement. Financial drafts and every publication use deterministic integer remaining-balance, policy ceiling, basis-point and clean-evidence checks. No LLM or human role bypasses those limits. Replacement additionally requires explicit permission in every applicable immutable purchase-policy clause; missing/conflicting flags fail closed.

## Verification

Final pnpm check passed: formatting, ESLint, strict workspace/test typecheck, all nine package builds, 59 unit tests, 107 integration tests and 8 browser tests: **174 passing tests**. The final browser run passed in 1.7 minutes. New negotiation coverage comprises three unit tests and ten integration tests; existing provider tests use mocks while database/RLS, Redis/queue, private storage and ClamAV checks use local services. No real PayPal or AI call was made.

Commands executed: pnpm format; pnpm typecheck; pnpm pretest; pnpm exec vitest run --project integration tests/integration/negotiation.test.ts (initial nine tests passed); pnpm db:migrate:test; pnpm db:migrate; pnpm check; pnpm test:e2e; final documentation formatting check. Both development and isolated test databases applied 0023/0024 successfully.

Failures were addressed rather than skipped. The first new test migration encountered an already-existing same-case supersession constraint. The duplicate declaration was removed; only the partially added new columns were cleaned in resolveai_test, Prisma marked the failed migration rolled back, and deployment then succeeded. No old migration or development data was reset. Initial lint findings in new tests/lifecycle assignment were corrected. An intermediate full browser run had six passes, a readiness 503 and a stalled sign-in timeout; a full browser rerun passed all eight without weakening checks. After the final replacement-clause safeguard was added, the entire pnpm check passed again, including all 174 tests in one invocation.

A separate read-only development database assertion confirmed the protected USD 100 capture remains COMPLETED, version 0, with reserved/refunded/external-refunded counters all zero. No capture, refund, payment worker mutation or provider request was initiated. Background AI configuration and credentials were not changed.

## Manual API review

1. Run pnpm db:migrate and restart the API. Sign in using existing seeded credentials; obtain session CSRF and current case version. Do not reseed development payment data.
2. Use an owned active internal complaint. POST customer-visible comments through the existing case comment endpoint for discussion.
3. As merchant, POST /api/v1/merchants/:merchantId/cases/:caseId/proposals with strict terms, explicit expiry, If-Match and Idempotency-Key. Legacy cases permit REQUEST_EVIDENCE/ESCALATION; financial terms require an eligible purchase policy.
4. As OWNER/APPROVER, POST /api/v1/cases/:caseId/proposals/:proposalId/actions with action PUBLISH, exact contentHash and reason; refresh case version first.
5. As customer, GET /api/v1/cases/:caseId/proposals; counter with POST proposals/:proposalId/counter, or reject with actions. Inspect immutable history and case timeline. Reuse the same key/body to verify exact replay.
6. Stop. Acceptance, settlement, refund workers and negotiation UI are intentionally absent until reviewed B/C/D. No real Sandbox refund, recapture or AI request is part of this demonstration.

## Review gate

Review domain permissions, nonbinding offer semantics, expiry persistence, API contracts, RLS and test evidence before authorizing B. B must implement exact-version customer acceptance plus distinct merchant financial authorization and reservation; C must verify current official refund contracts, UNKNOWN recovery and credential boundaries using mocks, with no real refund unless separately authorized. D owns negotiation UI/browser journeys. Existing Phase 2-5 browser journeys remain regression coverage; they are not evidence of a negotiation frontend.

## Changed modules and limitations

New source: packages/shared/src/negotiation.ts, packages/policy-engine/src/negotiation.ts, packages/case-store/src/negotiation.ts, plus their existing index exports. apps/api/src/cases.ts registers negotiation through existing authenticated tenant discovery. Prisma metadata and migrations 0023/0024 extend existing models. New tests: packages/policy-engine/src/negotiation.test.ts and tests/integration/negotiation.test.ts. README, AGENTS, architecture/database/API/security/test-plan/roadmap documentation describe the implemented boundary. No dependency or credential changes are needed.

A has no new AI offer-drafting endpoint or negotiation frontend. Existing consented analyses remain available through Phase 5 APIs; merchants may consult them manually, but no model can create/publish an offer. Real Gemini generation remains pending. Published offers are nonbinding until the reviewed settlement mechanism exists. Legacy purchase-policy cases, including legacy demo orders, permit information requests/escalation rather than financial entitlement; a future goodwill exception must be designed and reviewed explicitly, not achieved by mutating purchase history. Existing frontend bundle-size and color-environment warnings remain nonfatal. No claim of production readiness or real refund verification is made.
