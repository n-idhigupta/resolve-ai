# Phase 6 completion report

Status: synthetic/mock MVP implemented and verified locally on 2026-11-10; ready for the mock hackathon demo. Real PayPal refund execution and real Gemini verification remain disabled/pending. Prior Codex/Antigravity work, existing migrations and the protected Sandbox capture were preserved.

## Implemented

- Negotiation workspace: private merchant drafts, publication, customer counters, immutable terms/history, expiry, rejection and withdrawal. Revised publication supersedes pending counters; completed offers do not display actionable staleness warnings.
- Settlement: exact hash/version customer acceptance; separate OWNER/APPROVER authorization with authentication within 15 minutes; policy/evidence/freshness/balance rechecks; immutable approvals; serialized transactions and idempotent replay; cancellation before execution.
- Execution: atomic reservation + immutable refund operation + outbox. Assigned-account FORCE RLS, token-fenced leases, durable queue recovery and bounded attempts. Dispatch is persisted before POST. Once dispatch is uncertain, no blind re-POST/new key is permitted; UNKNOWN retains the reservation. Observed refunds reconcile through authoritative refund/capture/order reads.
- Webhooks: existing signature-verified inbox processing routes refund events to authoritative reconciliation. Invalid-first receipts cannot poison valid deliveries; replay/out-of-order events do not double-count. Untracked verified external refunds freeze the capture for manual accounting.
- Replacement: explicit merchant shipment and customer receipt acknowledgments complete a nonfinancial resolution. AI assistance only copies a fresh, consented, reviewed recommendation into an unsent draft; no inference, publication or execution occurs automatically.
- UI: separate customer/merchant actions, offer timeline, policy errors, exact-term confirmations, pending/unknown/completed states and clear synthetic/mock labels. Existing case discussions and private-note isolation remain intact.

## Root causes fixed

1. Migration 0026 removed table-wide worker reads but omitted Case.version. UPDATE version=version+1 therefore raised SQLSTATE 42501; completion rolled back and correctly retained the reservation as UNKNOWN. Additive 0027 grants SELECT on only that column, retaining private-field restrictions. Recovery uses the observed refund ID; no replacement refund is submitted.
2. Replacement receipt completion lacked UPDATE permission on Proposal.completedAt. Additive 0028 grants that column with state/consent completion guards, including denial of forged customer financial completion.
3. Sanitized database errors now distinguish persistence/permission failure from provider uncertainty. Regression tests inject a completion failure, verify atomic rollback, then reconcile with exactly one mocked POST.
4. PDF test timeout was shorter than the existing bounded extraction subprocess. Its test budget is now 20 seconds; the actual 15-second parser limit, isolation and content assertions are unchanged.
5. Fixed a read-consistency race exposed by the full browser run: the offer-list transaction now holds a case share lock, stale refresh responses cannot replace newer UI state, and browser actors wait for confirmed publication. Acceptance concurrency checks remain strict.
6. Preserved Antigravity's UI scope correction. Removed the debug script's embedded database credential; diagnostics now read isolated environment configuration and output only sanitized synthetic state/error information. Rotate the previously embedded local migration credential through a coordinated local configuration update; no credentials are reproduced here or changed automatically.

## Migrations and safety

0025 Settlement/approval/refund dispatch schema; 0026 least-privilege worker reads; 0027 required Case.version read; 0028 replacement completion and settlement state guards. All are additive migration files; no old migration was regenerated and no data was reset/deleted. The protected USD 100 capture was checked read-only: COMPLETED, version 0, reserved/refunded/external-refunded counters zero. Real refund account mode and PAYPAL_REFUNDS_ENABLED remain disabled; background AI was not enabled. Mock-worker credentials exclude PayPal, OpenAI, Gemini and original-storage secrets.

## Verification

Final pnpm check:safe passed: formatting, lint, strict workspace/test typecheck, all nine package builds, **63 unit + 15 integration + 8 browser tests = 86 passing tests**. The browser group passed in 36.2 seconds, including the real HTTP customer/merchant journey with a queued mock refund and refreshed completion status.

Coverage includes single-reservation/double-acceptance concurrency, retained unknown outcomes with no second POST, webhook verification stubs/replay, worker restart/recovery, atomic persistence-failure rollback and observed-ID reconciliation, least-privilege/RLS, exact version/hash and HTTP CSRF/ownership checks, replacement receipt/cancellation, concurrent publication snapshots, read-only storage, Redis/PostgreSQL connectivity and actual clean/EICAR ClamAV scanning. All provider calls were mocked; no real PayPal or Gemini request occurred.

The initial safe profile stopped on a lint escape, then exposed a stale-version browser race; both were fixed before the final successful invocation. Earlier five refund integration failures, replacement completion permission failure and the PDF test timeout were diagnosed and fixed rather than skipped. The protected capture and disabled feature/account flags were rechecked read-only. Frontend bundle-size and color-environment warnings remain nonfatal.

Commands: pnpm db:migrate:test; pnpm db:migrate; pnpm pretest; focused Vitest settlement and extraction/refund tests; focused Playwright settlement journey; pnpm demo:settlement; pnpm check:safe. Earlier failures and fixes are recorded above; results are not real-provider verification.

The safe profile runs all unit tests, append-only settlement/infrastructure integration, and shell/mocked-checkout/append-only settlement browser tests. Legacy integration suites and the old complaint browser fixture use TRUNCATE/reset or queue deletion, so they were deliberately not executed under the user's no-deletion boundary. Full legacy regression is pending a non-destructive fixture conversion or separate authorization. Existing evidence promotion/cleanup race suites were not rerun because they delete storage objects; read-only storage and actual scanner checks are included instead.

## Demo

1. Existing local services must be healthy. Run pnpm db:migrate. Do not run db:seed, local:init or any reset command against existing data.
2. Run pnpm demo:settlement to append a new synthetic fixture. It prints merchant/customer emails, merchantId and caseId; use the existing local DEV_SEED_PASSWORD (never printed). A fresh fixture was also created during this delivery: merchant settlement-merchant-ade07f6b@resolveai.test, customer settlement-customer-ade07f6b@resolveai.test, merchantId ade07f6b-ccba-4fb2-b97c-679789baa2a1, caseId 50637c6b-2c91-4040-acf6-74e2c6df9cdb. It is separate from the protected Sandbox payment.
3. Start/restart API and web: pnpm --filter @resolveai/api dev and pnpm --filter @resolveai/web dev. In a separate terminal run pnpm demo:refund-worker. This dedicated worker has no provider credentials and processes only synthetic mock accounts.
4. Merchant: open http://localhost:5173/merchant/MERCHANT_ID/cases/CASE_ID, sign in, save a private partial-refund draft (for example USD 25.00), then publish it.
5. Customer in another browser/private session: open http://localhost:5173/complaints/CASE_ID, sign in, inspect/counter the offer. Merchant may publish revised terms. Customer reviews the exact amount/terms/version, checks confirmation and accepts.
6. Merchant refreshes, reviews the separate authorization confirmation and authorizes. The worker completes the mock operation; refresh shows a mock reference and resolved settlement. No PayPal funds move. Replacement shipment/receipt follows its separate nonfinancial flow.
7. Use pnpm check:safe for repeatable verification without deleting existing data. Newly created synthetic fixtures/jobs are retained rather than cleaned up.

## Remaining limits

This is a mock-verified hackathon MVP, not a real-refund or production financial acceptance claim. Real refund/webhook behavior needs separately authorized Sandbox verification. Unknown dispatch without a recoverable refund ID requires a verified webhook or manual investigation; it never triggers a replacement charge/refund. External-refund accounting may require manual reconciliation after freezing. Legacy purchase policies do not invent refund entitlement; use the explicit synthetic policy fixture for this demo. Real Gemini generation remains pending separately. Existing frontend bundle-size warnings remain. No deployment, billing change or real provider mutation was performed.

## Subsequent authorized real Sandbox verification

The earlier mock-only financial limitation is superseded for the one isolated USD1 full-refund test: real capture/refund, signed delivery/replay, reconciliation and analytics passed. See SANDBOX-DOLLAR-TEST.md for IDs and safeguards. The protected USD100 capture is unchanged and refund execution is disabled again. This does not establish production readiness or real Gemini success; the latest authorized Gemini attempt returned503 with revoked consent.
