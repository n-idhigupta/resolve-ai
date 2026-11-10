# ResolveAI

ResolveAI helps merchants resolve internal payment complaints through verified payment context, private scanned evidence, consented AI assistance, human negotiation and separate financial authorization. React/Fastify/PostgreSQL FORCE RLS, durable operations and AG Grid Community support the workflow.

**Verified:** one isolated USD1 PayPal Sandbox purchase, capture, full refund, signed webhooks, replay protection, reconciliation and analytics. The original USD100 capture is unchanged. **Demo AI is mocked:** two authorized Gemini generation attempts returned503; no retries, model switches or billing activation are permitted. Refund execution is disabled again. No public deployment has occurred.

Delivery: [submission checklist](docs/DELIVERY-CHECKLIST.md), [exact Render steps/environment](docs/RENDER.md), [four-minute demo](docs/DEMO.md), [submission copy](docs/HACKATHON-SUBMISSION.md), [real Sandbox evidence](docs/SANDBOX-DOLLAR-TEST.md).

## Prerequisites and setup

Use Node **24.13.1**, pnpm **12.3.4**, and Docker Desktop/Engine with Compose and Linux containers. The digest-pinned development images target Linux amd64. Dependencies are exact-pinned in manifests and pnpm-lock.yaml; see [versions](docs/VERSIONS.md).

```sh
pnpm install --frozen-lockfile
pnpm local:init
pnpm infra:up
pnpm db:provision-payments
pnpm db:provision-evidence
pnpm db:migrate
pnpm db:migrate:test
pnpm db:seed
pnpm evidence:configure
pnpm scanner:up
pnpm dev
```

`local:init` explicitly generates ignored `.env`, `.env.test`, PostgreSQL bootstrap SQL and S3 credentials. It refuses to overwrite existing credentials. Do not regenerate settings against existing volumes: their passwords were set at first initialization. No production credentials are supplied. To configure manually, start with `.env.example`; create equivalent bootstrap roles/configuration before starting Compose.

The worker, API and web run through Turbo. Development identities are `admin@resolveai.test` (OWNER), `support@resolveai.test` (AGENT), `customer@resolveai.test`, plus separate-tenant/other-customer fixtures. Read the generated DEV_SEED_PASSWORD locally; no default password is committed. Seeding requires explicit ENABLE_DEV_SEED=true and is forbidden when NODE_ENV=production. No public signup or role switch exists. The checkout screen supplies a minimal sign-in form using the existing authentication API.

| Service                  | Local address                                              |
| ------------------------ | ---------------------------------------------------------- |
| Web                      | http://localhost:5173                                      |
| API liveness / readiness | http://localhost:3001/health and /ready                    |
| Auth                     | http://localhost:3001/api/v1/auth/login, /session, /logout |
| PostgreSQL               | localhost:5432                                             |
| Redis                    | localhost:6379 (password required)                         |
| Private S3 API           | http://localhost:9000                                      |

The Vite proxy keeps browser calls on one origin. Login/logout require Origin matching WEB_ORIGIN; logout also requires the session bootstrap's x-csrf-token. Cookies carry the session, never a bearer token in localStorage. The minimal sign-in and checkout screen is `/checkout`; see [PayPal setup](docs/PAYPAL.md) before enabling payments. There is no MinIO console: local storage uses SeaweedFS because planned MinIO images were unavailable. Storage is loopback-only development infrastructure, not a production deployment.

## Checks and operations

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
pnpm queue:smoke
pnpm check
pnpm infra:down
```

Run queue:smoke while the worker from pnpm dev is running. It enqueues only foundation.ping and waits for a real worker result. Integration tests require the isolated resolveai_test database, reset its synthetic data, and never silently skip missing services. E2E starts API/web if absent. `infra:down` preserves development volumes. No reset command deletes volumes automatically.

Docker proxy troubleshooting: if daemon pulls fail while host HTTPS works, `pnpm infra:load-images` downloads/checksums the pinned official image blobs through the host and loads digest references locally; then retry infra:up. It does not change Docker settings. It requires tar (tar.exe on Windows). Ordinary Docker pulls remain the default.

## Architecture and layout

```text
apps/web/                    React/Vite/Tailwind/shadcn shell and status
apps/api/src/                Bootstrap, sessions, scoped repositories, internal reservation
apps/api/prisma/             29-model schema, SQL migrations and guarded seed
apps/worker/src/             Ping queue, worker, failed-job retention and smoke command
packages/shared/             Zod DTOs, money, roles/permissions and job schema
packages/policy-engine/      Pure balance, limits and authorization checks
packages/paypal-client/      Typed Sandbox OAuth/Orders/Payments/verification client
packages/payment-store/      Shared payment engine, scoped persistence and delivery
scripts/                     Local infrastructure initialization and migration helpers
tests/integration/           Actual PostgreSQL/RLS/Redis/session/concurrency checks
tests/e2e/                   Browser routing and readiness/failure smoke tests
docs/                        Architecture and implementation evidence
.github/workflows/           CI checks with isolated local infrastructure
```

PostgreSQL owns workflow and balances; Redis schedules work; private object storage holds future evidence. OpenAI will recommend, deterministic policy will validate, humans will consent, and only an authorized future payment worker will execute. No external network calls occur inside database transactions. Internal refund reservations are not refunds and have no execution endpoint or queue consumer. Checkout/capture has its own durable executor; no refund/AI job is registered.

Read [architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [API](docs/API.md), [security](docs/SECURITY.md), [PayPal](docs/PAYPAL.md), [test plan](docs/TEST-PLAN.md), [roadmap](docs/ROADMAP.md), [Phase 2 report](docs/PHASE-2-REPORT.md), [Phase 3 report](docs/PHASE-3-REPORT.md) and [agent instructions](AGENTS.md).

Before live funds: verified seller onboarding, production identity/MFA/recovery, least-privilege process separation, provider verification/reconciliation, security/privacy/legal review, backed-up operational deployment and actual provider tests. No compliance, prevention rate or production-readiness claim. Select an open-source license and verify event rules before public submission.

## Enable Sandbox checkout

Payments remain disabled until explicit configuration. Follow [docs/PAYPAL.md](docs/PAYPAL.md) to create seller/buyer accounts, register a public HTTPS webhook, set private settings, run `pnpm paypal:configure` and restart apps. Use `/checkout` for buyer approval. `pnpm test:sandbox` is an opt-in manual real-provider test, excluded from CI; do not run it without valid Sandbox credentials.

Phase 4: open `/orders` or `/complaints`, sign in with a seeded customer/merchant account, and follow [the verified demo/setup guide](docs/PHASE-4-REPORT.md). Evidence remains unavailable if the scanner cannot complete. For the existing Docker proxy issue, use `pnpm scanner:load-image` before `pnpm scanner:up`. Do not regenerate credentials or reset the verified payment.

## Phase 5: AI intelligence (real-provider gate pending)

Existing payment and complaint workflows remain available without OpenAI. New AI recommendations are merchant-only and nonbinding. No offer, case closure, payment change or refund is created by analysis/review.

After the existing infrastructure setup, provision roles **before** applying the additive AI migrations:

```powershell
pnpm db:provision-ai
pnpm db:migrate
pnpm db:migrate:test
pnpm ai:configure
pnpm pretest
pnpm dev
```

Do not rerun local:init or seed against an existing demonstration database merely to enable AI. ai:configure assigns only the two seeded merchants and generates ignored artifact keys; it does not authorize data sharing. For a new installation, provision payment, evidence and AI roles before migrations; seed once, then run evidence:configure and ai:configure.

Set AI_ENABLED=true and a valid OPENAI_API_KEY only in the private root .env when ready for real inference; restart API and worker. Keep EVIDENCE_ENABLED=true and the real ClamAV service running for previews. No AI setting may use a VITE_ prefix. The worker development launcher separates payment, evidence/preparation and inference credentials. OPENAI_MODEL is informational; the reviewed model is pinned in ai-core.

In the merchant case page, owner explicitly enables an immutable sharing policy. Customer selects CLEAN evidence, prepares/reviews the exact request and consents. Merchant requests analysis and reviews its cited nonbinding result. Any material change requires new preview/consent. Revoke from the customer panel to prevent future transmissions. See [AI design](docs/AI-DESIGN.md) and [Phase 5 report](docs/PHASE-5-REPORT.md).

```powershell
pnpm ai:evaluate
$env:AI_EVAL_HELDOUT_ACK='FROZEN_PROMPT_NO_TUNING'
node scripts/ai-evaluate.mjs --heldout
pnpm ai:smoke:preview -- --image
# Review .local/ai-smoke-request.json. Copy its printed consent hash.
$env:RUN_REAL_AI_SMOKE='true'
$env:AI_SMOKE_SHARING_ACK='I_REVIEWED_THE_EXACT_SYNTHETIC_REQUEST'
$env:AI_SMOKE_CONSENT_HASH='COPY_THE_REVIEWED_PACKET_HASH'
pnpm ai:smoke
```

Synthetic smoke is opt-in, expires in one hour, allows one generation per consented packet and reserves at most USD 0.03 at pinned rates. Its child receives no database, storage or PayPal credentials. Preview makes no external call. This is independent of the application demonstration case. Never run real-provider tests automatically in CI. A valid real text/image/structured-output/counting receipt and quality evaluation are still required before declaring Phase 5 complete.

## Gemini provider

See [Gemini setup, consent and limitations](docs/GEMINI.md). AI_PROVIDER=openai remains the default; gemini now defaults to the explicitly selected gemini-3.5-flash-lite from ListModels; legacy2.5 remains recognized only with its separate protocol/consent and cutoff. AI_MODEL is validated against the selected provider. GEMINI_API_KEY is restricted to the inference worker; GEMINI_USAGE_CONFIRMED must remain false until eligibility/billing/terms are reviewed. No real Gemini request is authorized for this task.

Run pnpm gemini:smoke:preview for a local synthetic-only preview with no network or database calls. Google unpaid mode cannot process actual customer cases, even with consent. Existing payment/case workflows and OpenAI remain available.

## Negotiation milestone A

Human-authored negotiation APIs now support private merchant drafts, approver publication, customer counters, rejection, withdrawal, expiry and immutable case history. See [milestone A report](docs/PHASE-6-A-REPORT.md) for routes, permissions and verification. This historical milestone was followed by implemented frontend/settlement and the separately verified USD1 Sandbox full refund; see the current delivery checklist. Restart the API after pnpm db:migrate; do not reseed the verified development payment.

## Phase 6 settlement and mock demo

Human negotiation and exact-version settlement now extend the case workspace. Customer acceptance is separate from recent-authenticated OWNER/APPROVER authorization. Authorization atomically reserves integer funds, records immutable approvals, and creates a refund intent/outbox event. Workers use assigned-account FORCE RLS, leases and immutable request keys. UNKNOWN retains funds and never causes a blind second POST. Verified refund GET plus capture/order association precedes completion; duplicate events cannot increment counters twice. Replacement shipment/receipt is explicitly nonfinancial. AI can copy a fresh, consented reviewed recommendation into an unsent draft; it cannot publish, accept or authorize.

Real execution remains disabled. Run pnpm db:migrate, pnpm demo:settlement (creates new synthetic users/order/capture/case without altering existing data), pnpm --filter @resolveai/api dev and pnpm --filter @resolveai/web dev, then pnpm demo:refund-worker in another terminal. The demo command prints synthetic login emails and case ID; the password is your local DEV_SEED_PASSWORD and is never printed. Sign in as merchant to draft/publish, customer to counter/accept, and merchant to separately authorize. Mock completion is clearly labeled. Do not use the protected Sandbox payment for refunds. See docs/PHASE-6-REPORT.md.

Under the no-reset boundary, run pnpm check:safe. The legacy pnpm check integration/complaint-browser fixtures reset test data and are not safe under this authorization.

## Phase 7 hackathon demo

Run pnpm demo:hackathon to append an isolated synthetic tenant, then pnpm demo:start for the local mock stack. See [the demo script](docs/DEMO.md) and [verification report](docs/PHASE-7-REPORT.md). Real AI and financial execution remain disabled. Use pnpm check:safe under the no-reset boundary.

## Current real-integration readiness

See [integration readiness](docs/INTEGRATION-READINESS.md) for the two Gemini503 outcomes, completed USD1 Sandbox refund, isolated regression results and validated deployment configuration. Real Gemini output remains unverified; no deployment or billing activation is implied.

Sponsor technology: the merchant inbox uses AG Grid Community with React status/review renderers. See [hackathon submission copy](docs/HACKATHON-SUBMISSION.md).
