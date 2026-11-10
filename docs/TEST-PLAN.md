# Test plan

No application tests ran in Phase1: no implementation exists. Document checks verify file/link/contract consistency, not external behavior.

| Layer           | Required coverage / tools                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit            | Vitest money decimal conversion/exponents/bounds, policy, expiry/hash, strict DTOs and state maps; fixed clock and meaningful property/boundary cases.                                     |
| Database        | Real PostgreSQL migrations from empty/previous state; actual nonowner RLS roles, pooled context reset, composite FK, active-case/operation uniqueness, immutable content and reservations. |
| API             | Fastify inject + DB, auth/CSRF/roles/ownership, changed-body replay, stale If-Match, inaccessible-object404; two merchants/two customers.                                                  |
| Queue/outbox    | Real Redis/BullMQ, crash before/after enqueue, lost Redis, duplicate delivery, expired leases; DB convergence.                                                                             |
| Payment adapter | Deterministic fake HTTP faults for auth refresh, timeout classification, Retry-After, fixed host, immutable key/body; separate real Sandbox suite.                                         |
| AI              | Fake structured refusals/incomplete/invalid references/stale snapshot; held-out real-model evaluation with budget and versioned reports.                                                   |
| Evidence        | Storage/scanner integration: mismatch, overwrite, malware, PDF bomb/encryption, denied downloads, unsafe rendering; no quarantined parsing.                                                |
| Browser         | Playwright checkout->complaint->upload->analysis->offer->counter->reapproval->accept->refund->timeline; responsive and keyboard checks.                                                    |
| Analytics       | Exact seeded currency buckets, completed-only totals, denominators, date boundaries, repeated joins and tenant filters.                                                                    |
| Accessibility   | Automated checks plus manual focus/grid/labels/screen-reader status on critical journey.                                                                                                   |

## Financial concurrency and recovery gates

1. Concurrent execute of same proposal: one operation/reservation; same resource or safe conflict.
2. Competing reservations cannot exceed capture gross; historical/conflicting proposals tested defensively despite one-active-case rule.
3. Counter versus execute serializes on case/version; executing offer cannot supersede.
4. Provider succeeds then worker dies before commit: UNKNOWN retains funds, same key retries, verified webhook/GET completes once.
5. Timeout or DB failure after send: no new key/operation; safe-window expiry requires manual investigation.
6. Lease expires while old worker pauses: reject stale local writes and preserve external key.
7. Duplicate/reverse-order webhooks, completion before HTTP response and invalid-first event ID: no poisoning/double count/regression.
8. External dashboard refund races with local reservation: freeze discrepancy, import verified external identity without local double count.
9. Lost capture response: GET relation/payee/amount before paid state.
10. Total Redis loss: outbox plus durable-operation sweeper recovers all authorized work.

Adversarial fixtures: tenant substitution in URL/body/queue, other-customer chunk ID, email-only ownership, forged capture/amount/currency, expired consent, forged role, CSRF, key/body mismatch, webhook flood, certificate SSRF, hidden PDF/model instructions, fake policy/source/receipt, unsupported currency and CSV injection. All financial bypass attempts fail closed and disclose no cross-tenant data.

## Actual Sandbox checklist

Record date and account/app mapping. Real buyer approval, order/capture GET association, amount/currency/payee; approved partial then remaining refund; actual response/error/status shapes; real event names and successful signature verification. Replay same key/body. Verify endpoint-specific retention from current spec/account documentation, not a short experiment. Simulator covers ingress only for postback approach. Use documented negative-testing facilities where available; label local simulated failures separately. Formal disputes remain disabled unless entitlement established. Scrub secrets/personal data from reports.

CI Phase2: lint/format/typecheck/build/unit. Later real isolated DB/Redis/storage and Playwright. External secrets never available to untrusted PRs. Gates before demo: all financial/tenant/consent/injection cases pass, no unresolved critical/high security issue, clean recorded Sandbox journey and restart/restore rehearsal. Load/latency claims require measured volume/hardware. Production needs further operational/security review.

## Phase 2 executable checks

Run pnpm test, pnpm test:integration and pnpm test:e2e after the README setup. Integration tests use real runtime/migration roles and PostgreSQL/Redis; they explicitly reset only resolveai_test synthetic data. No service-unavailable skip is used. Browser tests cover the foundation shell and actual readiness plus intercepted failure rendering. AI/payment/evidence attack suites above remain later-phase requirements. Actual command outcomes are recorded in PHASE-2-REPORT.md.

## Phase 3 executable coverage

Provider unit tests inject HTTP transport for OAuth single-flight/expiry/refresh, key/body preservation, create/capture responses, transient/definitive errors, timeouts, unsafe IDs and original webhook formatting. Payment integration tests exercise actual customer/worker roles, intent/outbox transactions, parallel captures, frozen amounts, raw encrypted receipts, signature rejection, valid-after-invalid delivery, stale events, lease fencing, failed provider reads, queue acknowledgment loss, worker restart and safe retry-window expiry.

Browser checkout tests explicitly mock both SDK and payment API; they cover login, success, advisory cancellation and reconciliation-required UI. Existing browser readiness tests still exercise local API/DB/Redis. Real BullMQ ping/payment processing tests run separately. No mocked result is evidence of actual PayPal settlement. The real Sandbox command is explicit opt-in only, is absent from CI/check, and fails when required configuration is missing. PHASE-3-REPORT.md records actual final results.

## Phase 4 executable coverage

The complaint integration suite uses isolated PostgreSQL roles, actual SeaweedFS and actual ClamAV: clean/EICAR, outage quarantine, content/hash spoofing, upload/cleanup and promotion lease races, queue restart recovery, note privacy, immutable policies/history, ownership and tenant denial. Browser tests exercise the actual isolated customer/merchant flow with real scanning and policy publication. No PayPal payment calls are made. Run pnpm scanner:up before pnpm check; missing scanner/storage is a failed prerequisite, not a skipped success. Generated test objects are deleted using isolated test metadata only.

## Phase 5 verification additions

Provider adapter unit tests mock fixed-host HTTP, strict output, refusal/incomplete/error handling, transient classification and fail-closed token fallback. Actual subprocess tests parse UTF-8/PDF and re-encode PNG. Integration tests use only resolveai_test and dedicated resolve_ai_test/resolve_evidence_test credentials: consent, privacy, immutable snapshots, dedupe/concurrent runs, staleness, revocation before/during send, invalid output/citations, quota failure, usage holds, lease recovery, real CLEAN storage extraction and BullMQ delivery, review permissions and expiry. Existing Phase2–4 RLS/auth/payment/storage/ClamAV/concurrency suites remain required.

Browser complaint journey adds real API/session/CSRF/customer consent, actual preparation and inference queues, merchant citations/approval and revocation; only provider output is mocked. Several browser identities share loopback IP: preserve the global limiter and honor Retry-After rather than disable it. Run DB integration and browser suites sequentially.

40 synthetic fixtures have disjoint development/heldout IDs/narratives. Frozen deterministic safety runs are separate from real-provider quality. scripts/ai-quality.mjs requires20 genuine-output records with model/prompt provenance, valid usage and optional two-reviewer claim annotations; it reports structured/citation/policy checks, remedy agreement, latency, tokens/cost and supported-claim precision only when all cases are reviewed. No quality measurements are fabricated. Real smoke requires reviewed synthetic packet, explicit one-hour consent, key and opt-in; never automatic in CI.

## Gemini regression coverage

Tests use fake keys and injected SDK models or mocked SDK HTTP, never real provider requests. Coverage includes exact text/image/schema mapping, Developer API token-count serialization, no SDK hidden retry, quota/error normalization, malformed/refused/missing-usage/unexpected-model rejection, cost bounds, credential allowlists, configuration errors, synthetic provenance, new provider consent, revocation, changed-case freshness, idempotency, unknown usage/retry, merchant review and payment immutability. The browser complaint journey now includes distinct OpenAI and Google consent/review cycles; model/configuration responses are mocked while HTTP/session/RLS/storage/scanner/queues are real. Full DB integration and browser suites remain sequential. Real availability/quota/output quality is a separate deferred gate.

## Phase 6 milestone A regression

Negotiation API integration fixtures are synthetic and restricted to resolveai_test. They cover immutable drafts/publication/counters, private-draft RLS, role authorization, missing-context and foreign-tenant reads, optimistic concurrency, exact idempotent replay/conflicts, stale context/hash/version, timed expiry, rejection/withdrawal history, CSRF/unauthorized HTTP/input validation, denied acceptance and absence of Approval/RefundOperation/reservation effects. Unit cases exercise partial/full refund suggestions against integer limits, required clean evidence, legacy policies and bounded expiry. Full existing Phase 2�5 unit/integration/browser suites must pass at each reviewed milestone. Milestone A adds no negotiation UI; its browser tests cover regression only. Real PayPal/AI smoke scripts are excluded; no external operation is authorized. See PHASE-6-A-REPORT.md for actual results and any retries.
