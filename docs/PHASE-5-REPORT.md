# Phase 5 implementation and verification report

Date: 2026-11-10. Status: **integration-ready, pending genuine OpenAI verification and model-quality acceptance**. No real OpenAI API key was configured during this work. No provider success, model accuracy or full Phase 5 completion is claimed.

## Delivered behavior

- Immutable exact-request sharing previews, per-case customer consent bound to selected source manifest and immutable sharing policy, explicit retention disclosure and append-only revocation.
- Allowlisted trusted context with public discussion and purchase policy; private merchant notes and full payment identifiers excluded. CLEAN evidence only, local bounded UTF-8/PDF parsing and image re-encoding, versioned encrypted derivatives and source references.
- Strict Responses provider abstraction with fixed endpoint, pinned model/prompt/schema, no tools, timeouts, streamed response limits, sanitized diagnostics and input-token preflight. Conservative text-only fallback fails closed; images require working preflight.
- Deterministic bigint candidate construction, remaining-balance/policy/basis-point checks, citation/quote/page/source validation and uncertainty fallback. Legacy synthetic policies imply no refund entitlement.
- Separate inference and preparation processes/credentials, assigned-tenant FORCE RLS, durable outbox, BullMQ, fenced leases, recovery, deduplication, rate limits, daily micro-USD holds and unknown-outcome accounting.
- Merchant-only findings/citations, processing/failure/stale states, review/revision, history comparison and estimated usage. All approvals/revisions revalidate current consent, source freshness, authorization and the same candidate constraints.
- No proposal, customer offer, case closure, payment mutation, capture or refund is created by AI/review.

## Repository changes

New packages/ai-core: provider.ts, contracts.ts, extraction.ts, extract-child.ts, prepare.ts, service.ts, engine.ts and focused tests. Shared schemas live in packages/shared/src/ai.ts; deterministic recommendations in packages/policy-engine/src/recommendations.ts.

API routes: apps/api/src/intelligence.ts, registered through the existing bootstrap. Merchant/customer panel: apps/web/src/intelligence.tsx within existing complaint details. Worker entries: ai-main.ts, evidence-main.ts and intelligence-worker.ts, launched with explicit per-process allowlists through scripts/worker-launch.mjs. Existing payment worker behavior remains separated.

Local provisioning/configuration: scripts/provision-ai.mjs and configure-ai.mjs. Verification: ai-evaluate.mjs, ai-quality.mjs, ai-smoke.mjs and restricted smoke child; tests/evaluation, fixtures and extended integration/browser suites. CI provisions the AI role before migrations and never opts into real provider calls.

README, AGENTS, ARCHITECTURE, DATABASE, API, AI-DESIGN, SECURITY, TEST-PLAN, ROADMAP, VERSIONS and .env.example now describe the implemented boundaries. The original proposed AI-to-proposal workflow is explicitly future scope. Preparation preview uses asynchronous POST/GET rather than performing storage extraction during a GET.

## Additive migrations

| Migration                    | Purpose                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0013_ai_intelligence         | Eleven tenant-scoped AI tables; extend Analysis, FindingReference and EvidenceChunk; typed sources, FORCE RLS, fixed-scope freshness and immutable content |
| 0014_ai_guards               | Extraction chunk identity, same-case FK, dispatch timestamps, output hashes and expiry boundary                                                            |
| 0015_ai_delivery             | Assigned-role outbox delivery permissions for preparation/inference                                                                                        |
| 0016_ai_privacy_recovery     | Hash comment manifest bodies and clear expired outputs in two immutable-safe stages                                                                        |
| 0017_ai_retention            | Age-gated encrypted extraction erasure with immutable provenance retained                                                                                  |
| 0019_ai_authoritative_inputs | Restrict preparation updates to derivative fields; keep authoritative inputs immutable and independently recompute inference/review candidates             |
| 0018_ai_extraction_outcomes  | Distinct immutable failed/successful extraction outcomes and database actor/role checks for consent/review                                                 |

New tables: AISharingPolicy, AIContext, AIConsent, AIRevocation, EvidenceExtraction, AnalysisSource, AIRecommendation, AIReview, AIUsage, AIBudget and AIWorkerTenant. Existing captures/counters/migrations were preserved. No destructive development reseed was run. Tests reset only guarded resolveai_test.

## Original Phase 5 verification record (before Gemini)

Final sequential pnpm check: **passed**, exit 0.

| Check                                                                  | Actual result                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Formatting / ESLint / strict typecheck                                 | Passed                                                                                   |
| Workspace build                                                        | All 9 packages passed; Vite large-bundle warning only                                    |
| Unit tests                                                             | 45 passed across 12 files                                                                |
| Integration / security / RLS / concurrency / worker / storage / ClamAV | 91 passed across 5 files, including 21 AI integration tests                              |
| Browser tests                                                          | 8 passed, including real customer-to-merchant consent/citation/review/revocation journey |
| Total automated tests                                                  | **144 passed, 0 failed in final run**                                                    |
| Real Redis/BullMQ foundation ping                                      | Passed, queue:smoke returned ok:true                                                     |
| Deterministic evaluation                                               | 40 cases, 386 assertions passed; no model calls                                          |
| Frontend secret-value scan                                             | Passed; no configured payment/storage/session/AI secrets in built JS                     |
| Real-provider smoke opt-in guard                                       | Passed: absent explicit authorization rejects before transmission                        |
| Real OpenAI generation / vision / counting compatibility / quality     | **Not executed; pending key and explicit smoke consent**                                 |
| Local infrastructure                                                   | PostgreSQL, Redis, SeaweedFS and ClamAV healthy                                          |
| Additive migrations                                                    | 0013–0019 applied to development and isolated test DBs                                   |

The final build/typecheck/test run was sequential. No integration/database reset overlapped browser verification. Latest complete run: 45 unit, 91 integration and 8 browser tests; no skipped-infrastructure substitution.

Commands actually executed include pnpm db:provision-ai; pnpm ai:configure; pnpm db:migrate; pnpm db:migrate:test; pnpm pretest; pnpm format; pnpm format:check; pnpm lint; pnpm typecheck; pnpm build; pnpm check; focused Vitest AI integration/provider/extraction checks; focused Playwright complaint checks; pnpm queue:smoke; node scripts/worker-launch.mjs --check-environments; node scripts/ai-evaluate.mjs (development and acknowledged held-out); node scripts/ai-smoke.mjs --preview --image; guarded smoke opt-in probe; docker compose service-health inspection; frontend secret-value scan; and read-only capture fingerprint checks. Role provisioning and configuration generated only ignored local credentials; no key or password is printed.

The synthetic text/image smoke preview and authorization guard were verified locally. No real generation was attempted, no actual customer evidence was shared externally, and no real-provider receipt was fabricated.

The database/storage/scanner/browser tests use real local infrastructure and isolated synthetic captured-payment fixtures. Provider responses in deterministic tests are mocked. They do not prove account-level OpenAI compatibility, factual quality or real provider latency.

Failures encountered and corrected: malformed terminator in the new 0016 migration (marked only that failed migration rolled back, then reapplied); invalid synthetic PNG fixture and extractor startup timeout; strict header typing; browser citation-role assertion; several browser identities exhausting a shared loopback-IP limit. Browser forwarding now uses distinct loopback source addresses to represent independent clients while preserving actual HTTP and unchanged production limits. AI UI displays retry advice for 429. An initial concurrent build/typecheck collided while both regenerated Prisma; an overridden storage-failure fixture needed the correct Buffer<ArrayBuffer> type; final checks run sequentially. No failed command is represented as a pass.

## Evaluation and costs

40 synthetic cases: development D01–D20 and held-out H01–H20 with distinct narratives and IDs. Prompt/schema fingerprint frozen before held-out safety checks:
0364e06f7ed85168a43d30e41b5e98a358dced20d892c856239a09e8054fc1bc.
No prompts were tuned using held-out cases. Default harness loads only development; held-out requires explicit acknowledgment and unchanged fingerprint. Deterministic safety results: 20 cases/193 assertions per split, 40 cases/386 assertions total, zero model calls. These measure guards, not model quality.

Quality scoring accepts synthetic-only genuine-provider result records with exact model/prompt provenance; it reports validated structured/cited/policy-compliant output, expected-remedy agreement, latency/token/cost distribution, and supported-claim precision only with complete independent two-reviewer annotations. Real model quality, unsupported-claim rates, appropriate escalation and provider latency remain **not measured**. The dataset is a reproducible hackathon evaluation starting point, not production accuracy evidence.

Pinned documented standard rates: input USD0.75/M tokens, output USD4.50/M. Caps16000 input/4000 output imply USD0.03 per attempt; maximum three attempts. Daily budget defaultsUSD5 and is merchant-policy limited; unknown outcomes retain reservation. No real provider charges were incurred by this work. Prices are versioned estimates, not billing guarantees. Synthetic smoke makes at most one generation per exact consented packet and has a USD0.03 ceiling.

## Exact local demonstration

1. Keep existing PostgreSQL, Redis, SeaweedFS and ClamAV running. Use pnpm scanner:up if necessary. Do not reset/reseed the development database or recreate the completed payment.
2. pnpm db:provision-ai; pnpm db:migrate; pnpm db:migrate:test; pnpm ai:configure; pnpm pretest. On a fresh installation, follow README provisioning order; all role provisioning must precede migrations.
3. With a real provider key available, set private root .env AI_ENABLED=true and OPENAI_API_KEY; leave EVIDENCE_ENABLED=true. Keep AI_ARTIFACT_KEY private. Never expose these as VITE_ settings.
4. Restart affected processes with pnpm --filter @resolveai/api dev and pnpm --filter @resolveai/worker dev in separate terminals; web with pnpm --filter @resolveai/web dev (or pnpm dev for all).
5. At http://localhost:5173/complaints use the seeded customer login and existing eligible captured order. Existing repeated-complaint limits still apply; do not bypass them. For repeatable automated demos use pnpm test:e2e and its isolated synthetic fixtures.
6. Merchant owner admin@resolveai.test opens the case and explicitly enables the AI sharing policy. Customer selects available CLEAN evidence, chooses Prepare sharing preview, reviews every text/image/settings/disclosure and consents.
7. Merchant requests analysis, sees processing then validated findings, trusted server facts, citations, omissions and permitted candidates. Inspect a citation. Approve/reject/revise with a reason. Observe that the case/payment remains unchanged.
8. Add a public comment or other material case change: prior analysis must become stale and cannot be approved/revised. Prepare a new preview and obtain new customer consent.
9. Customer revokes consent: future dispatch and review stop. Already authorized/in-flight provider transmissions cannot be recalled. Provider retention remains applicable.

Without a key the real inference panel stays explicitly disabled; local preparation/consent and the existing manual complaint workflow remain available. Do not simulate a successful AI response in the application to conceal this gate.

## Dedicated real-provider smoke

Run pnpm ai:smoke:preview for text, or node scripts/ai-smoke.mjs --preview --image for a generated synthetic teal square. Read .local/ai-smoke-request.json and its retention disclosure. It contains no actual customer evidence, DB identifiers or PayPal records. Packet expires in one hour.

In PowerShell, set RUN_REAL_AI_SMOKE=true, AI_SMOKE_SHARING_ACK=I_REVIEWED_THE_EXACT_SYNTHETIC_REQUEST and AI_SMOKE_CONSENT_HASH to the printed hash, then pnpm ai:smoke. A valid private key is required. Child receives only OS runtime variables, OpenAI key and bounded smoke authorization; no database, storage, session or PayPal credentials. Only fixed OpenAI endpoints exist in this path. Sanitized receipt goes to ignored .local/ai-smoke-receipt.json. A dispatched packet cannot be reused; prepare/review/consent anew for another test.

Real-provider status: **not executed**. Text and image preflight/generation, strict schema acceptance and genuine usage must be verified on the actual provider account. Do not enable this in CI.

## Preserved payment and remaining risks

Read-only local fingerprint confirms capture 7ND54081CF0194732 remains COMPLETED, USD10000 minor units, reserved0, refunded0, version0, original verifiedAt2026-11-09T18:24:39.050Z. No PayPal order/capture/refund was initiated in Phase5. This is preservation verification, not a new provider lookup.

- No key means no genuine model/image/token-count endpoint acceptance or real-provider quality metrics.
- Citation integrity does not prove entailment. All findings need human review; injection safety is structural authority isolation, not a promise that the model cannot be misled.
- Text redaction is heuristic; images may contain personal information. Customer preview/consent and provider privacy approval are necessary.
- Process environment/SQL separation is verified; production requires distinct OS/container identities, filesystem/egress controls, managed encryption/keys and operational security review.
- Retention sweeps require a running worker; unknown provider usage remains conservatively budgeted until operational reconciliation. Local erasure cannot recall provider-held data.
- No external OCR service: scanned PDFs use bounded page images. Complex/password-protected/oversized content is omitted and requires manual investigation.
- Current model and budgets are deliberately pinned. Other providers/models, large documents and pricing changes need reviewed adapters/schema/budget updates.
- Vite reports an existing large bundle warning; code splitting is future UX optimization.

## Phase 6 prerequisites

Complete genuine text/image/counting/structured-output smoke, collect and adjudicate held-out quality results, sign off provider privacy/retention and deployment isolation, and review policy semantics. Then separately authorize versioned negotiation/proposal/customer-acceptance design. An approved AI internal decision must never be treated as customer consent or payment authority.

## Gemini continuation (2026-11-10)

The interrupted SDK installation was preserved; adapter/configuration/consent/tests/docs were completed as described in [GEMINI.md](GEMINI.md). Real Gemini verification is explicitly deferred: no Gemini API requests, account checks, token preflight or generation were made. Google’s current model-specific/deprecation pages limit gemini-2.5-flash to existing users and announce2026-12-01 rerouting; the adapter blocks that boundary and unexpected returned versions instead of switching models. OpenAI support and consent remain separate. Gemini initial mode is synthetic-only because of unpaid-data restrictions.

### Completed changes

- Preserved the existing pinned @google/genai3.0.0 installation and prior Phase2–5 implementation. No Git metadata was present; working-file/package/lockfile/migration inspection established the interrupted state.
- Added gemini.ts (official SDK adapter), gemini-wire.ts (deterministic generation/count previews) and selection.ts (validated provider/model configuration, conservative integer pricing and model revalidation).
- Extended the existing provider/service/engine with provider-bound consent, exact Google SDK previews, source and deterministic policy checks, provider-specific metering and provider-mismatch rejection. OpenAI support and the original evaluation fingerprint are unchanged.
- Updated API safe configuration metadata, restricted inference selection, worker key allowlists and API/legacy-worker dotenv key filtering. GEMINI_API_KEY is not exposed to frontend/payment/evidence environments or source control. No private credential values were changed to enable Gemini.
- Added provider-specific customer warnings/previews and separate OpenAI/Google browser review cycles. Google unpaid mode permits trusted synthetic case versions only; no application endpoint can authorize a real customer case.
- Applied additive migrations0020_gemini_provider and0021_gemini_fixture_freshness to development and resolveai_test. Existing FORCE RLS and runtime-role restrictions remain; financial tables/counters and earlier migrations were not modified.
- Added a network-free synthetic preview command, provider SDK/configuration/consent/budget/retry tests, and updated configuration/security/architecture/API/version documentation.

### Final regression evidence

Final pnpm check completed with **exit0** after correcting the test harness.

| Verification                                                      | Actual result                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Formatting, lint and strict typecheck                             | Passed                                                                                                               |
| Application/package builds                                        | All9 passed; existing Vite bundle-size warning only                                                                  |
| Unit tests                                                        | 55 passed across14 files                                                                                             |
| Integration/security/RLS/storage/scanner/concurrency/worker tests | 97 passed across5 files;27 AI integration tests                                                                      |
| Browser tests                                                     | 8 passed, including separate OpenAI and Google consent/review/revocation cycles                                      |
| Total                                                             | **160 passed,0 failed in the final full run**                                                                        |
| Provider SDK tests                                                | Actual Google SDK serialization with mocked HTTP, plus injected-model tests; no real request                         |
| Frozen evaluation                                                 | Both20-case splits passed193 deterministic assertions each;386 total, unchanged prompt fingerprint, zero model calls |
| Synthetic smoke preview                                           | Local preview created; externalRequests0; invocation without preview rejected                                        |
| Secret-value bundle scan                                          | Passed, including the configured Gemini key; no values printed                                                       |
| Real Gemini availability/counting/generation/vision/quota/quality | **Not executed; explicitly pending**                                                                                 |
| Preserved payment                                                 | COMPLETED,USD10000 minor, reserved0,refunded0,version0, original verifiedAt unchanged                                |

Integration and browser database suites ran sequentially. The browser uses real HTTP/session/CSRF, PostgreSQL RLS, private storage, ClamAV and queues; model output/provider-selection responses are mocked. These results do not establish real provider compatibility, semantic quality or actual quota.

Commands executed: pnpm db:migrate; pnpm db:migrate:test; pnpm db:generate; pnpm pretest; pnpm format; pnpm lint; pnpm typecheck; pnpm check; focused Gemini Vitest tests; focused AI integration tests; focused complaint Playwright tests; node scripts/gemini-smoke-preview.mjs --preview; development and explicitly acknowledged held-out evaluation; read-only capture fingerprints; smoke execution-guard and frontend secret-value scans. Official Google documentation was retrieved without credentials; no Gemini API endpoint was called.

Failures corrected rather than skipped: SDK3.0.0 rejected countTokens systemInstruction in Developer API mode, so counting now includes instruction/schema text with a conservative allowance; dotenv isolated maps needed Record<string,string> types; the browser configuration override needed to preserve non-success responses and honor the existing limiter window between two full provider journeys. The final run passed without weakening authentication, RLS or rate limits.

### Real verification, quotas and next steps

**Zero real Gemini API requests were made.** No models.list/get, token-count, generation or image request used the actual key. Eligibility, region/billing/free-quota status, model access, real diagnostics/usage, observed quotas and model-quality measurements remain unverified. The user explicitly deferred real requests; GEMINI_USAGE_CONFIRMED remains a separate operator prerequisite, not proof of access.

The adapter retains gemini-2.5-flash and rejects unreviewed models. Google’s current model-specific/deprecation pages say existing-user access only and2026-12-01 automatic rerouting; ResolveAI blocks requests on/after that date rather than selecting the vendor replacement. Account-specific access cannot be inferred from a key or documentation.

Conservative published-rate estimates use inputUSD0.30/M and outputUSD2.50/M including thinking; configured maxima implyUSD0.0148 and retain the existingUSD0.03 reservation. Unknown generation outcomes retain holds; SDK hidden retries are disabled. No real inference charge was incurred by these tests. Free quota and actual billing are not assumed or measured.

Before future separately authorized real verification: confirm account/region/billing and requested-model generation eligibility; review the exact synthetic-only preview and Google-specific terms/consent; authorize a small bounded run; verify genuine text/image structured output, citations, deterministic policy and merchant review in isolated fixtures; record actual usage/quota/diagnostics. Do not use the completed Sandbox order or real customer/private merchant data. A paid Google mode for actual customer cases requires separate privacy/disclosure review and new consent. No automatic model upgrade or Phase6/payment execution is included.

## Subsequent real Gemini smoke (2026-11-10)

A separately authorized, consent-bound, synthetic-only generateContent attempt targeted gemini-2.5-flash after the user reported Free tier and nonzero remaining model quota. **One request returned HTTP404 NOT_FOUND; no retry or model switch occurred.** No model output, returned model or usage metadata was provided, so structured-output/citation/policy validation could not run. No quota error was returned. Billing, app configuration and PayPal operations were untouched. Prior statements of zero real calls apply to the implementation/regression stage, before this authorization. Real-provider acceptance remains incomplete. See [GEMINI-SMOKE-REPORT.md](GEMINI-SMOKE-REPORT.md) for caps, authorization and evidence.

## User-authorized model discovery and replacement (2026-11-10)

A read-only ListModels call succeeded. The explicitly selected replacement is gemini-3.5-flash-lite, advertised with generateContent and documented free-tier/structured-output support. Configuration and strict model/protocol/return-version allowlists were updated; migration0022 extends only the AI policy model constraint. OpenAI and legacy2.5 policies remain supported, with provider-specific consent, synthetic provenance, RLS and financial guards unchanged. Background inference and billing remain disabled.

The user-authorized single new synthetic generation returned **HTTP400 INVALID_ARGUMENT**, no model output, no usage and no quota error. There was no retry or additional fallback, and no PayPal operation. Structured-output/citation validation and genuine generation compatibility remain unverified. The secret-safe normalizer did not retain the exact rejected-field diagnostic. See GEMINI-SMOKE-REPORT.md.

Formatting, lint, typecheck and all nine package builds passed. Unit tests: 56 passed. Integration tests: 97 passed against isolated real database/RLS, queue, storage and scanner fixtures, with provider responses mocked. The first browser run had 6 passes and 2 timeouts during a prolonged stall (uncertain-payment display and evidence-download journey); pnpm test:e2e was rerun without code or security changes and all 8 passed in 2.3 minutes. Thus the final suite results are 161 passing tests across the successful runs, not a clean first pnpm check invocation. An earlier test-argument typecheck error was corrected before rerunning. Migration 0022 succeeded on development and isolated test databases. These results do not establish real Gemini output quality or successful generation.
