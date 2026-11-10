# Dependency-aware roadmap

Phase1 is this planning package. Implementation starts only when requested. Each phase must satisfy its tests/acceptance and update documentation to actual behavior.

| Phase                         | Depends                     | Objectives, files and tasks                                                                                              | Acceptance/testing                                                                          | Definition of done                                                            |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 Architecture                | None                        | README, AGENTS, docs, env; explicit boundaries/contracts/invariants/risks                                                | Required files/links consistent, no features                                                | Reviewable planning package                                                   |
| 2 Foundation/data security    | 1                           | Root pnpm/Turbo/TS/lint manifests; app/package scaffolds; apps/api/prisma schema+SQL; local services; auth/seed; CI      | Build/typecheck; real-role RLS/composite FK/session/role/ownership tests; clean migration   | Bootable reproducible workspace and tenant identity boundary; no payment flow |
| 3 Checkout/durable operations | 2                           | paypal-client OAuth/orders/capture/GET; CheckoutOperation/outbox/inbox/leases/status API/basic order UI                  | Actual Sandbox capture/payee/amount association; duplicate/timeout/capture-recovery tests   | Verified captured order, contract notes and scrubbed provider evidence        |
| 4 Cases/policy/evidence       | 2; 3 for paid-order journey | Case APIs/screens, policy-engine, immutable policies, signed storage, scan/extraction/timeline                           | Owned case, one active case, type/scan/overwrite/download/policy snapshot tests             | Usable secure complaint/manual-review flow                                    |
| 5 Intelligence                | 4                           | Strict shared AI contracts, snapshot/retrieval/recommendation/citation jobs, explorer, eval fixtures                     | AI-DESIGN held-out/adversarial gates; outage/refusal/stale tests                            | Grounded findings, no execution authority, manual fallback                    |
| 6 Negotiation/consent         | 4; 5 for assisted drafts    | Immutable proposals/hash/expiry, customer decisions/counters, merchant approvals, replacement/evidence tasks             | Approval/counter/expiry concurrency tests and audit                                         | Exact-version both-party agreement and manual proposal support                |
| 7 Safe refunds                | 3,6                         | Reservations, RefundOperation, worker/client, verified webhooks/reconciliation, approval/status UI                       | Actual partial+remaining Sandbox refund; all financial crash/race/unknown gates             | Recoverable money operation; unresolved outcomes frozen                       |
| 8 Analytics/demo              | 5,7                         | Community grid, currency metrics, accessibility/responsiveness, demo fixtures/video/setup                                | Complete Playwright journey, known analytics fixtures, keyboard and clean Sandbox rehearsal | Functional reproducible hackathon prototype with truthful evidence            |
| 9 Production future           | 8                           | Authorized multi-seller onboarding, MFA, scoped processes, privacy/legal/retention, security review, restore/alerts/SLOs | Entitlement review, incident/restore drills, independent security review                    | Explicit go/no-go with operational owner; disputes separately gated           |

## Exact next steps for Phase 2

1. Read AGENTS and current design; obtain the user's next-phase instruction rather than treating this plan as feature authorization now.
2. Check official compatibility docs, pin maintained Node/pnpm/package versions. Create package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, format/lint config, .gitignore and CI. Do not publish or commit without task authorization.
3. Scaffold web/API/worker manifests and package exports. Minimal Vite shell, Fastify health/readiness and graceful worker only; enforce strict TypeScript/dependency rules.
4. Add shared Money/ID/error/role/state schemas, pure policy primitives and paypal-client interface. Real provider adapter belongs Phase3.
5. Implement Prisma schema and SQL RLS/composite FK/check/partial-index/immutability migrations. Include receipt-child and reconciliation discrepancy fields. Separate migration/runtime roles; guarded membership discovery.
6. Configure local PostgreSQL/Redis/S3 and isolated test DB, environment validation per process, no secrets committed. Scanner setup can be prepared; processing is Phase4.
7. Seed two merchants/users/roles/policies/owned unpaid orders. Implement seeded identity login/session/logout/CSRF; no unauthenticated role switch or public registration.
8. Meaningful money/session/permissions/actual-role-RLS/composite-FK/pool-reset tests. Provide lint/typecheck/build/test scripts; CI and empty-DB migration pass.
9. Replace setup plans with commands actually verified; report checks/limits and Phase3 gate. No PayPal/AI integration claims yet.

## Decision and risk register

| Item              | Current decision                                            | Gate / responsible role                                               |
| ----------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| Seller            | One Sandbox seller, no implicit marketplace authority       | Product/payments before second seller: verify onboarding/permissions  |
| Identity          | Seeded authenticated sessions                               | Security before public users: verification/MFA/reset/recovery         |
| Money             | USD/one full capture; future schema extension               | Payments before currencies/captures: provider/exponent verification   |
| Policy            | Immutable purchase snapshot; human ambiguity handling       | Merchant/legal before public use: mandatory rights review             |
| AI model/cost     | Configure after availability and held-out eval              | AI owner Phase5; no assumed price/quality                             |
| Provider behavior | Official pages reviewed; no API calls yet                   | Payments Phase3: schema, key retention, errors/events/access verified |
| External refunds  | Reconcile/freeze; outside race cannot be eliminated locally | Payments/operations before live funds                                 |
| Privacy           | Synthetic data and bounded retention                        | Security/legal before PII: region, terms, erasure and notices         |
| Replacement       | Manual shipment/receipt acknowledgments                     | Product before logistics integration                                  |
| License/contest   | Intended open source, unselected license/unverified rules   | Maintainer before publishing/submission                               |
| Hosting           | Render/managed single-region services                       | Operations verifies current tiers/network/backups before provisioning |

## Phase 2 implementation scope update

The requested foundation implementation includes read-only order routes to exercise ownership over HTTP. Local storage is SeaweedFS rather than unavailable MinIO images. Phase 2 does not implement a full policy resolver, outbox relay, external adapters or complaint workflow. See PHASE-2-REPORT.md for verification and remaining gates; do not infer completion from this roadmap.

## Phase 3 delivery status

Checkout/capture, worker account-scoped RLS, durable outbox/inbox, provider client, reconciliation and minimal checkout UI are implemented. Local automated checks use injected/mock provider responses and real PostgreSQL/Redis. **Real Sandbox verification is pending because credentials are unset.** Phase 3 is integration-ready, not fully provider-verified. Complete PAYPAL.md manual checkout/webhook verification first; then implement Phase 4 cases, purchase policy and secure evidence. Refunds, AI and formal disputes remain excluded.

Phase 3 Sandbox verification update (2026-11-10): one real USD100 capture, paid-order refresh and signed webhook verification/processing confirmed. Duplicate receipt reprocessing and automated regression checks pass. See PHASE-3-REPORT.md; live-money readiness remains outside scope.

## Phase 4 implementation update

Complaint lifecycle, versioned policies, private evidence, optional real ClamAV, restricted evidence jobs and customer/merchant pages are implemented. Final status and actual gates are recorded in PHASE-4-REPORT.md. Nonfinancial closure is explicitly separate from settlement/refunds. Follow with Phase 5 intelligence; Phase 4 does not authorize AI or money execution.

Phase 4 local completion (2026-11-10): 115 automated tests passed; real ClamAV, private storage, RLS and the isolated customer-to-merchant browser journey verified. Proceed to Phase 5 within the nonfinancial boundaries documented in PHASE-4-REPORT.md.

## Phase 5 implementation checkpoint (2026-11-10)

AI local preparation, exact consent, deterministic recommendation guardrails, merchant-only inference/review, role-isolated asynchronous recovery and evaluation tooling are implemented. Real OpenAI account/model/text-image/counting compatibility and held-out model-quality acceptance remain pending; Phase 5 must not be marked fully complete without them. See PHASE-5-REPORT.md for actual verification results. Phase 6 prerequisites: real-provider gates, privacy/retention sign-off, policy semantics review, and a separately authorized design for versioned nonbinding-to-binding proposals/customer consent. No Phase 6 execution is implied by approving an AIReview.

Gemini extension: implemented within the existing Phase5 architecture, with Google unpaid synthetic-only scope and separate consent. Real Gemini requests remain unauthorized/pending, along with actual existing-account model access and quota confirmation. No model upgrade or Phase6 execution is implied. See GEMINI.md and PHASE-5-REPORT.md.

## Phase 6 reviewed milestones

The current user-authorized breakdown groups negotiation and future refunds as Phase 6: A domain/APIs, B settlement/financial guards, C refund worker/reconciliation, D frontend/E2E. A is implemented and locally verified (174 tests); B-D were subsequently authorized together and are implemented with synthetic/mock verification; see PHASE-6-REPORT.md. Older Phase 7 refund entries remain historical planning, not authorization to execute funds. See PHASE-6-A-REPORT.md. Real Gemini generation remains pending separately; background AI stays disabled. No real Sandbox refund is authorized.

## Phase 6 continuation

B-D are authorized without intermediate reviews. Settlement consent, atomic reservations, durable refund execution/reconciliation and negotiation UI are implemented with synthetic/mock verification. Real refunds and real Gemini remain disabled and unverified. No existing data may be reset/deleted; use check:safe rather than the legacy reset-based suite. See PHASE-6-REPORT.md for actual results and remaining demo prerequisites.

## Phase 7 local demo

Tenant-isolated operational analytics and an append-only synthetic demo now reuse the existing complaint, consent, review, negotiation and queued mock settlement pipeline. `demo:start` disables real checkout/refunds/inference and uses separately credentialed local mock workers. No provider key is forwarded to these workers. See DEMO.md and PHASE-7-REPORT.md. Real-provider quality/refund acceptance gates remain pending; this is the mock hackathon path, not production readiness.
