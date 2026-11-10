# Integration and deployment readiness � 2026-11-10

ResolveAI is **not fully verified end to end**. Real Gemini generation remains an open acceptance gate. The authorized isolated USD1 Sandbox capture/full refund is now verified; see the final update below. No production deployment or billing change occurred.

## Real Gemini result

The user confirmed Default Gemini Project is Free tier, has no billing account linked, and showed remaining gemini-3.5-flash-lite quota (0/15 RPM, 0/250000 TPM, 0/500 RPD). Billing status is operator UI confirmation; an API key cannot independently query Cloud billing.

One new synthetic application smoke used an appended isolated test merchant/case, actual uploaded text evidence, actual CLEAN/scannedAt verification, the exact immutable Google disclosure and source-manifest consent, restricted inference-role credentials, and the normal AnalysisEngine. No real customer information, private merchant notes or protected payment IDs were included. Inference received no PayPal, original-storage or migration credentials.

- Model metadata GET: succeeded; generateContent advertised; version 3.5-flash-lite-07-2026.
- countTokens: succeeded; conservative preflight including schema allowance **6224**, cap 16000.
- generateContent: **one attempt**, HTTP **503 UNAVAILABLE**, normalized **PROVIDER_HTTP_503**; no retry or fallback.
- Returned model/output/actual generation token usage: none returned. Structured output, citations, real recommendation and merchant review therefore **not verified**.
- Output cap 4000; paid-rate upper estimate USD0.0148; attempt reservation USD0.03. Actual cost is unknown, not claimed zero. UNKNOWN budget accounting is retained.
- Consent was revoked after the failure, blocking subsequent dispatch even if a worker later sees the queued row. Normal background inference remains disabled.

The old 400 receipt discarded Google's error detail, so its exact rejected field cannot be established retrospectively. Official Google guidance identifies complex responseJsonSchema grammar (especially nested array/numeric bounds) as a possible 400 cause. New consent protocol **gemini-sdk-v3** simplifies only the provider grammar, maps const to enum and leaves strict server Zod/citation/financial validation unchanged. Historical v1/v2 wire mappings remain unchanged. This is compatibility hardening, **not a proven root-cause fix**: the 503 prevents a real success claim. Secret-safe diagnostics now retain only bounded approved field paths, status and a reason category; never raw error payloads.

Private receipt: `.local/gemini-application-smoke-20261110.json`. The one-attempt marker prevents automatic reruns. Public tooling is `scripts/gemini-application-smoke.ts` and its restricted child. It refuses missing explicit opt-in/Google-sharing acknowledgement; the current attempt cannot be repeated by that command. Another real attempt requires new authorization and a fresh bounded artifact. Text/image serialization is covered with mocked SDK transport; genuine image inference remains unverified.

Official references: [selected model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [schema complexity](https://ai.google.dev/gemini-api/docs/structured-output), [thinking](https://ai.google.dev/gemini-api/docs/thinking), [unpaid terms](https://ai.google.dev/gemini-api/terms). Reviewed documentation and successful metadata/counting are separate from successful generation.

## Separate Sandbox refund approval packet

`node scripts/sandbox-refund-preflight.mjs` is read-only and constructs no provider. Proposed test: **one new USD1.00 Sandbox purchase/capture and one full USD1.00 refund**, on a disposable local order/account binding with manual buyer approval. This needs explicit financial approval; nothing was created or charged/refunded in this task. Never use the protected USD100 capture.

After approval, provision an isolated assigned account/order; verify the buyer-approved server capture; open the synthetic complaint and scan evidence; obtain fresh exact Google consent and real validated analysis/review (currently blocked); negotiate an exact version; obtain separate customer acceptance and merchant authorization; enable execution only in the isolated worker for the approved intent. Keep the protected account disabled. Verify refund GET identity/amount/currency/invoice/up-capture link, actual signed webhook delivery at `POST /api/v1/webhooks/paypal/:accountKey`, inbox replay, reconciliation, one counter increment and zero remaining reservation. Disable that isolated worker afterwards. A timeout/unknown result retains its reservation and never permits a new blind POST/key. If no refund ID is recoverable, stop for provider/manual reconciliation.

Mocked integration/browser tests cover authorization, concurrent reservations/acceptance, partial/refund limits, duplicate intents/events, UNKNOWN recovery and worker leases. They do not establish real refund API success or live tunnel delivery. Full real-provider journey is pending both Gemini success and financial approval.

## Full isolated regression

With explicit user approval, a new local database `resolveai_verify_20261110` was created, all 30 existing migrations applied, and separate private verification buckets initialized. Existing development and resolveai_test databases were not reset. A single appended synthetic real-AI fixture in resolveai_test is preserved. Verification queues use logical Redis database15 with test prefixes. Integration and browser stages run sequentially; browser files use one worker on this target.

```powershell
# Already created: this refuses to overwrite/reset an existing database.
$env:RESOLVEAI_CREATE_VERIFY_ACK='CREATE_NEW_DISPOSABLE_DATABASE'
node scripts/verification-init.mjs
# Reuse that isolated environment for checks:
node scripts/verify-isolated.mjs
```

Legacy reset fixtures now refuse existing local databases outside approved verification/ephemeral CI. The first full integration run exposed an obsolete Phase3 test expecting no RefundOperation privilege; Phase6 intentionally grants scoped access. The replacement checks missing/foreign tenant denial. Worker startup additionally validates FORCE RLS on 15 payment/settlement/refund tables. A subsequent in-progress run saw stale module-cache exports while test tooling was being edited; final verification uses a fresh process after edits, with no assertion weakened.

## Deployment preparation

Dockerfile provides nonroot API and Nginx web targets; .dockerignore excludes all environment files, .local, node_modules and artifacts. API now supports API_HOST=0.0.0.0 for container networking, retaining loopback by default locally. OpenSSL/CA certificates are installed. `deploy/compose.yaml` uses a same-origin web proxy, API readiness health check, restricted runtime credentials, no development seed, no provider keys, disabled inference and disabled financial execution. Migrations are a separate manual profile with distinct credentials; never expose migration credentials to API/worker services.

```powershell
docker compose --env-file .local/deploy-validation.env -f deploy/compose.yaml config --quiet
docker build --target api -t resolveai-readiness-api:local .
docker build --target web -t resolveai-readiness-web:local .
```

These commands build/validate locally; they do not deploy. Production configuration rejects Sandbox checkout/refund flags; settlement authorization refuses financial execution in production; mock refund and demo inference processes reject production. No live-payment implementation is activated. Before any deployment, use a reviewed HTTPS gateway/custom same-site domain, private managed PostgreSQL/Redis with TLS and backups, private object storage, an available scanner, secret-manager injection and rotation, monitoring/alerts, tested restore, dependency/image vulnerability review, and a controlled migration rollout. Container builds retain workspace build tooling; a reduced runtime image and SBOM/security scan remain release hardening. Production multi-seller onboarding and live payments remain outside this release.

Final command outcomes and test counts are appended after verification. Do not equate container/config validation with production deployment, load/restore testing or provider acceptance.

## Final executed verification

- `node scripts/verify-isolated.mjs`: **PASS**, 69 unit + 127 integration + 11 browser = **207 tests**, zero final failures. Formatting, ESLint, strict typecheck (including smoke tooling), all nine package builds passed. Includes actual storage/ClamAV, RLS, concurrency, inbox replay, crashed leases, consent/citations/review, mocked checkout/refunds and full synthetic settlement/analytics.
- The complete browser run exposed a genuine post-revocation UI bug: a successful server mutation was obscured by a 429 on its follow-up read. The UI now retains confirmed revocation and distinguishes refresh failure. Tests honor existing Retry-After and wait for the refreshed counteroffer before submitting a new version; no limiter/version/security check was weakened. Earlier failed runs are not counted as successful.
- Frozen deterministic evaluation: development20/193 assertions and held-out20/193 assertions passed; **zero model calls**, no prompt tuning and no model-quality result.
- Both final Linux Docker targets built with pinned base-image digests. Compose validation passed. Nonroot API/container `/health` and `/ready` returned200; Nginx syntax and same-origin root/status/readiness proxy returned200. Containerized read-only migration status: all30 migrations current. Secret environment files absent from image; production mock/Sandbox worker guards and disabled direct inference entrypoint verified.
- Initial container startup exposed missing storage settings; the Compose template now requires them. The first web build had a transient BuildKit failure; retained-log rebuild succeeded. Workspace tooling remains in the runtime image; image/SBOM/vulnerability and operational production reviews remain outstanding. Frontend bundle-size warning is nonfatal.
- Temporary readiness containers were stopped. New verification database/buckets were retained. Protected USD100 capture remains COMPLETED/version0, all refunded/reserved/external counters zero; protected account, real refunds and background inference remain disabled. The failed real-Gemini fixture remains appended with revoked consent.

Acceptance status: (1) real Gemini recommendation **pending�503**; (2) real Sandbox refund **pending explicit financial approval**; (3) full real-provider workflow **pending**; (4) full regression **passed**; (5) local deployment/config/image validation **passed**, actual production rollout/operational readiness **not claimed**. No real capture/refund, billing change or deployment was performed.

## Final hackathon integration update

The former refund approval blocker above is superseded: the authorized single USD1 Sandbox purchase/full refund completed. Order 8SE437503D359100F is COMPLETED; capture 6Y521778HF557060P is REFUNDED; refund 30M07053WJ648601P is COMPLETED. Actual signed refund delivery and exact signed replay passed. Local ledger is refunded100/reserved0/CURRENT, settlement complete, provider analytics100. Isolated execution is disabled again and the protected USD100 capture is unchanged. See SANDBOX-DOLLAR-TEST.md.

After fresh user authorization and renewed Free-tier/no-billing/quota confirmation, one additional synthetic application attempt used exact Google consent and actual scanned text. Metadata succeeded (version3.5-flash-lite-07-2026), countTokens preflight6224; the single generation returned PROVIDER_HTTP_503 / UNAVAILABLE. No output or generation usage was returned, no quota error was reported, consent was revoked, and no retry/model switch occurred. The 16000/4000 token caps, USD0.0148 upper estimate and USD0.03 reservation were preserved; actual cost remains unknown. Receipt: ignored .local/gemini-final-result.json. Real structured output/citations/policy recommendation/merchant review remain unverified. Background inference remains disabled.

Render preparation: render.yaml describes only two free web services, automatic deployments off, existing production payment/AI guards preserved. Official JSON Schema validation passed. No deployment, paid resource or billing change. See RENDER.md. Full real-provider end-to-end completion is not claimed because real Gemini remains unavailable.

Final focused verification: 31 mocked-provider/configuration/SDK/refund safety unit tests passed across six files. The updated Linux web image built successfully, including all nine package builds. Nginx entrypoint substitution and syntax passed for default HTTP and HTTPS upstreams; changed-document formatting passed. Official Render schema validation passed. The unsupported Dockerfile Prettier check failed because Prettier has no Dockerfile parser; Docker itself parsed and built it successfully. No unnecessary full-regression rerun: the previously recorded 207-test isolated full regression remains the last full-suite result.
