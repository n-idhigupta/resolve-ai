# Persistent contributor instructions

Phase 1 is documentation only. Implement features only when the user requests a subsequent phase. Read README and docs/ARCHITECTURE.md, DATABASE.md, PAYPAL.md and ROADMAP.md first. Keep contracts, states, examples and environment settings consistent.

- Use the chosen TypeScript stack and modular monolith; avoid unnecessary infrastructure.
- Strict Zod boundary validation; shared contracts cannot import application/infrastructure code.
- AI cannot approve, execute or override policy. No payment tools or credentials in prompts.
- Tenant-scope every query and enforce customer ownership. Composite tenant FKs and RLS supplement explicit authorization.
- Integer minor units and explicit currencies; BIGINT DTOs are decimal strings. Never floating-point money.
- Approvals bind immutable content/hash/policy/actor/expiry. Counters require renewed consent.
- No database transaction during network calls. Durable operations, reservations, outbox/inbox, stable provider keys and reconciliation are mandatory. UNKNOWN retains funds.
- Verify webhook signature/account/resource before effects. Browser redirects are not capture proof.
- No secrets, personal evidence, raw prompts/provider payloads or signed URLs in Git/logs. Default Sandbox; live payments/formal disputes disabled.
- Consult official APIs; distinguish documentation review from actual Sandbox testing. Do not invent capabilities or indefinite idempotency.
- Use AG Grid Community only and accessible uncertainty/payment states.
- Test tenancy, consent, financial races, retries, injection and recovery; never claim unexecuted checks.
- Update documentation with behavior. Do not publish/deploy/send messages without task authorization.

## Phase 2 status

Phase 2 is authorized. Implement only foundation, auth/read-only orders, schema/RLS, deterministic primitives and harmless ping processing. Follow README for actual commands. Do not enable payment, AI or complaint workflows. SQL migrations are authoritative for relational constraints and RLS; never regenerate already-applied migrations. Tests may reset only the explicitly isolated resolveai_test database.

## Phase 3 authorization

Phase 3 checkout, capture, verified webhooks and reconciliation are authorized. Keep refunds, AI, complaints and formal dispute execution disabled. Reuse existing primitives and run deterministic tests; real Sandbox smoke requires explicit opt-in and valid credentials. Payment workers use assigned-account RLS with separate non-owner roles.

## Phase 4 authorization

Implement internal complaints, immutable purchase policies and quarantined evidence with a real scanner gate. No AI, financial settlement, refunds or PayPal disputes. Preserve the verified capture. Only isolated resolveai_test fixtures may be reset; never run database integration/browser suites concurrently against that database. See PHASE-4-REPORT.md for scanner setup and actual acceptance gates.

## Phase 5 authorization and safeguards

Implement AI internal intelligence only. packages/ai-core owns allowlisted contexts, bounded extraction, exact per-case consent, provider schema/citation validation and durable inference. policy-engine computes candidate remedies; merchant revisions cannot bypass those constraints. AI does not write proposals, case closure or financial state. Preserve all previous migrations and the verified Sandbox capture. Additive migrations 0013–0019 enforce new FORCE RLS and role separation.

Use scripts/worker-launch.mjs credential allowlists; do not start inference with the root .env or PayPal/storage credentials. Keep provider evidence derivatives encrypted, no prompt/evidence logs. Never tune prompts with held-out cases; preserve tests/evaluation/prompt-freeze.json. Missing OpenAI key/consent means real verification pending, never a mocked success. See docs/AI-DESIGN.md and PHASE-5-REPORT.md.

## Gemini provider extension

Retain OpenAI and the original Phase5 pipeline. Use only explicit AI_PROVIDER/AI_MODEL allowlisted pairs; never silently switch models. Google unpaid mode is restricted to trusted, version-bound synthetic fixtures: consent cannot override the provider's prohibition on personal/confidential data. Only the migration role may set synthetic provenance. Keep GEMINI_API_KEY exclusively in the selected restricted inference worker environment. Preserve provider-specific immutable disclosures, exact previews, consent and revocation. Model-specific deprecation cutoff and unexpected-version checks must fail closed. No real Gemini requests are currently authorized; account eligibility, actual model access and real-provider quality remain pending. See docs/GEMINI.md and the report.

## Phase 6 milestone A authorization

Implement negotiation domain/APIs only, using existing comments, Proposal, policy snapshots and tenant transactions. Published/own-counter history is customer-visible; private merchant drafts remain hidden even after withdrawal. No ACCEPT, Approval, RefundOperation, execution outbox, AI invocation or payment mutation in A. Stop for review before B settlement, C refunds or D frontend. Preserve all existing captured funds and background AI disablement. Run full regression suite and record failures/retries truthfully in PHASE-6-A-REPORT.md.

## Phase 6 B-D current authorization

The user authorizes B-D end to end without intermediate review. Preserve prior work and the protected USD 100 capture. Real refund/capture calls, real Gemini calls, deployment and billing changes remain forbidden; real refunds stay disabled. No database reset, TRUNCATE or data deletion, including legacy test fixtures. Use pnpm check:safe and append-only synthetic fixtures; report excluded reset-based suites. Mock refund workers receive no provider credentials and may process only explicitly synthetic mock accounts. Never replace an UNKNOWN operation with a new financial intent; keep reservations until authoritative resolution.

## Latest integration verification boundaries

The one newly authorized synthetic Gemini generation attempt returned 503 UNAVAILABLE; its consent was revoked and its one-attempt marker must not be reset or rerun without fresh authorization. Normal AI and real refunds stay disabled. The user approved only the new resolveai_verify_20261110 database for reset-based verification; existing resolveai and resolveai_test must not be reset. Use node scripts/verify-isolated.mjs for the full suite. The separate USD1 Sandbox purchase/full-refund plan still requires explicit financial approval. Production Sandbox/mock financial execution is intentionally blocked. See docs/INTEGRATION-READINESS.md.

## Latest completed controlled Sandbox test

The user-authorized single new USD1 Sandbox purchase/full refund completed and its financial authorization is consumed. Order8SE437503D359100F/capture6Y521778HF557060P/refund30M07053WJ648601P are reconciled. Isolated refund execution is disabled again. Do not repeat dispatch markers or touch protected USD100 funds. One fresh authorized synthetic Gemini generation returned503 and consent was revoked; no further real AI request is authorized. Render configuration is prepared only; deployment/resources require approval. See SANDBOX-DOLLAR-TEST.md and RENDER.md.
