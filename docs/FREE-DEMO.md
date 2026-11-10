# Strict INR0 public demo - prepared, not deployed

Use `render.free-demo.yaml`, not the normal `render.yaml`, for this deliberately limited public demo. No credit card, billing activation, paid compute, disk, domain or provider call is allowed. If any signup requires a payment method or offers only paid plans, stop: do not upgrade or bypass verification. Free-plan documentation does not prove eligibility for this particular account.

## What the profile does

Production-mode sessions, CSRF, rate limits, runtime-role safety checks, FORCE RLS, ownership and tenant authorization remain unchanged. The separate entrypoint `apps/api/src/free-demo-main.ts` refuses provider/storage/migration/worker credentials and any execution/seed flag not explicitly false. It starts no worker. The normal production entrypoint still requires real storage configuration; its behavior and payment guards are not relaxed.

The demo supports authenticated persisted orders, complaint/case views and actions, customer/merchant discussion, human negotiation, policy management and AG Grid/analytics over authorized synthetic records. Evidence initiation/content/completion/download return EVIDENCE_DISABLED after session/ownership/CSRF checks; no upload record or object is created. Existing evidence metadata remains authorized, but no file is downloadable. Policies requiring evidence still apply and may block submission. No scanner result is invented.

No S3 service/key, Gemini/OpenAI key, PayPal credential or AI artifact key is needed. New AI inference, encrypted AI-history access, payment checkout/capture/refunds, automated settlements and evidence processing are unavailable. The UI may show existing disabled/error states on those screens; this is not a polished replacement for the full local worker demo. Present the recorded verified USD1 Sandbox transaction and separately labelled local mock-AI demo, never claim those operations ran in this public deployment.

## Exactly four Free resources

| Resource                                   | Dashboard name       | Plan                          |
| ------------------------------------------ | -------------------- | ----------------------------- |
| Render PostgreSQL17                        | resolveai-demo-db    | Free, fresh DB resolveai_demo |
| Render Key Value (Redis-compatible Valkey) | resolveai-demo-redis | Free, noeviction              |
| Render Node web API                        | resolveai-demo-api   | Free                          |
| Render Docker web frontend                 | resolveai-demo-web   | Free                          |

All must be in one region/workspace. No S3, scanner or background worker is provisioned. The two backing services are manual so ownership/role bootstrap can be verified before API startup. The Blueprint never injects the default owner PostgreSQL URL into runtime.

## Manual setup in order - only after deployment/resource approval

1. Sign up/sign in at Render with the hackathon GitHub account, use the no-monthly-fee Hobby workspace and leave billing/payment method unset. Review Free eligibility and usage allowance. Stop if a card is required. No action here was executed remotely.
2. **New > PostgreSQL**: select Free, version17, name resolveai-demo-db, database resolveai_demo, user resolve_migrator, same region planned for both web services. Do not add backups, disks, replicas or paid features. Creating starts the30-day Free expiry. Do not reuse an existing protected database.
3. From **Connect**, obtain the external administrator/migration URL privately. Restrict database external access to your operator IP. This is for one-time local DBA/migration setup; do not paste it into chat or the API. Verify that the managed account permits named role creation and schema ownership. Provision the nine migration-referenced roles: resolve_migrator (schema owner), resolve_runtime (nonowner login), resolve_test, resolve_payments, resolve_payments_test, resolve_evidence, resolve_evidence_test, resolve_ai, resolve_ai_test. Unused test/worker roles must be NOLOGIN. Runtime must be NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOINHERIT, with no memberships/schema CREATE. Set its new password via a secure interactive prompt, never a committed SQL literal. Keep migrations/schema owned by resolve_migrator; grant runtime only the existing migration-defined permissions. If the provider cannot support this exact role model, stop: compatibility is not verified merely by provisioning a database.
4. Use an approved local DBA terminal with the new external MIGRATION_DATABASE_URL privately set; `pnpm db:migrate` applies all30 immutable migrations. Never reset, use migrate dev or run local provisioning commands against the hosted DB. After migration, verify runtime guards/RLS using the new runtime URL. The local scripts are intentionally localhost-only; hosted role/bootstrap and managed privilege compatibility require operator verification. No hosted compatibility test has been run.
5. Provision fresh synthetic login identities and policy/order/case fixtures through a reviewed one-time admin step. There is no signup and production development seeding remains disabled. Do not copy the local databases, customer evidence, sessions or protected payment. Without this step the public UI has no usable account. The current local demo seed command is not a hosted provisioning command.
6. **New > Key Value**: name resolveai-demo-redis, same region, Free, noeviction, external connections disabled. Obtain its **Internal URL** from Connect; use authenticated internal access where supported. This supplies REDIS_URL, not a REST-only Redis URL. Do not add payment details or enable a paid persistence plan. Free Key Value is volatile; no business state is stored solely in it.
7. The prepared changes must first reach the approved connected GitHub branch through a separately approved commit/push. **New > Blueprint**: select the repository and Blueprint path **render.free-demo.yaml** (if the UI cannot select a custom file, create the two web services manually with settings below). Review every plan as Free; do not apply until deployment is approved.
8. Enter the runtime DATABASE_URL derived from the database's Internal URL using resolve_runtime plus its separately provisioned URL-encoded password, with the same exact host/port/database/query options. Never use the default resolve_migrator credentials. Enter REDIS_URL from step6, WEB_ORIGIN and API_UPSTREAM as below. Render generates SESSION_HASH_PEPPER and CSRF_SECRET; retain them across restarts. No S3/AI/payment/worker/migration key belongs in the API environment.
9. To avoid guessing URLs, manual creation can run API first using a temporary closed origin `https://pending.invalid` (valid HTTPS, not an allowed real site). Copy the actual API public URL into web API_UPSTREAM. After web is assigned its actual public URL, replace API WEB_ORIGIN with that exact origin and restart API **before login testing**. Alternatively use the actual URLs if shown during Blueprint setup. Never guess suffixes, use private API hostnames or leave the temporary origin as the final setting.
10. After approval, create/deploy API and web. Test `/health`, `/ready`, `/status`, synthetic login/logout, Secure cookies, CSRF rejection, own-tenant cases/grid/analytics and another-tenant404. Check evidence-disabled behavior. No financial/provider smoke test is part of acceptance. Only then share the public URL. Record that the hosted deployment is restricted; do not advertise the full real-provider journey.

### Manual web-service settings

API: Node runtime; Node24.13.1; build `npm install --global pnpm@12.3.4 && pnpm install --frozen-lockfile --prod=false && pnpm build`; start `node apps/api/dist/free-demo-main.js`; health `/ready`; Free; automatic deployments off.

Web: Docker runtime; root Dockerfile/context, final Nginx stage; health `/health`; Free; automatic deployments off. No separate Vite frontend API variable is necessary: requests use same-origin `/api/v1` through the HTTPS proxy.

### Environment values

| API variable                                    | Value/source                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| NODE_VERSION                                    | 24.13.1                                                                                                                             |
| NODE_ENV / API_HOST / API_PORT                  | production / 0.0.0.0 / 3001                                                                                                         |
| RESOLVEAI_FREE_DEMO                             | true                                                                                                                                |
| PAYPAL_ENABLED / PAYPAL_REFUNDS_ENABLED         | false / false                                                                                                                       |
| AI_ENABLED / EVIDENCE_ENABLED / ENABLE_DEV_SEED | false / false / false                                                                                                               |
| DATABASE_URL                                    | Hosted internal PostgreSQL URL using only resolve_runtime; preserve encoding and required TLS options                               |
| REDIS_URL                                       | Same-region Key Value Internal URL; native redis:// or rediss://                                                                    |
| WEB_ORIGIN                                      | Actual frontend HTTPS origin; no path or trailing slash                                                                             |
| SESSION_HASH_PEPPER / CSRF_SECRET               | Blueprint-generated independent secrets; manual creation requires independent random values at least32 characters, stored privately |

Only web variable: **API_UPSTREAM** = actual public API HTTPS origin, no path/trailing slash. Example shape only: `https://resolveai-demo-api-<assigned>.onrender.com`. WEB_ORIGIN uses the corresponding actual frontend origin. Never append `/api/v1`, put secrets in VITE_ variables or copy values from the local .env.

## Verified published free-tier constraints

- Render documents Free web, PostgreSQL and Key Value. No payment method means excess included bandwidth suspends services and excess build minutes stops builds; do not link a card. Account-specific signup/verification eligibility is not verified here.
- Two Free web services share750 workspace hours/month; they sleep after15minutes idle, may take about a minute to wake, have ephemeral filesystems, no shell/one-off jobs/persistent disks and cannot receive private-network traffic. API_UPSTREAM therefore uses public HTTPS, while API can reach its same-region datastores internally.
- One Free PostgreSQL per workspace,1GB, expires after30days, no backups or managed pooling. Never solve expiry by enabling billing; retain only disposable synthetic data and plan to stop the demo. One Free Key Value per workspace; all state lost on restart.
- External AI/payment execution is off. No paid worker/service is hidden in this plan. No object storage is needed because evidence access is explicitly disabled. Backblaze advertises a no-card B2 signup, but there is no reason to create it for this profile; cloud storage/scanner integration has not been verified here.

Sources reviewed2026-11-10: [Render Free](https://render.com/docs/free), [Render FAQ and no-payment-method behavior](https://render.com/docs/faq), [Key Value connections](https://render.com/docs/key-value), [Blueprint](https://render.com/docs/blueprint-spec), [Backblaze no-card signup](https://www.backblaze.com/sign-up/cloud-storage).

## Feasibility and verification status

A restricted, database-backed public demo has a plausible INR0 architecture using the advertised Free tiers, contingent on account eligibility, managed role compatibility and successful synthetic hosted provisioning. **A fully functional real-evidence/AI/payment/worker end-to-end demo is not provided or verified at INR0.** No signup, cloud resource, hosted migration, public deployment or billing change was performed. No guaranteed availability/no-card approval for a specific account is claimed.

Local verification results are appended below. Existing production configuration is retained; new free-demo files are uncommitted and unpushed until separately authorized.

### Local checks completed

Official Render JSON Schema validation passed for render.free-demo.yaml. Eight unit tests passed (existing production configuration plus free-demo credential/execution guards). Four integration tests passed using append-only synthetic fixtures in the approved isolated verification database: production Secure/HttpOnly login, own-case access, anonymous401, cross-tenant404, CSRF403, disabled evidence503 without new records, content/complete/download denial, and unchanged normal-production storage requirements. Lint, monorepo/test typecheck and all nine package builds passed; unchanged frontend retains its existing nonfatal bundle-size warning. Changed-file formatting passed. No hosted deployment, provider inference, PayPal request, reset or billing action was executed.
