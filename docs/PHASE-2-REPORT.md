# Phase 2 completion report

Implemented and verified locally on 2026-11-09. Phase 2's development Definition of Done is satisfied. This is a foundation release, not a live-payments or production-ready deployment. No application was published, Git history initialized, commit created, or external message sent.

## Delivered structure

```text
.github/workflows/ci.yml
apps/
  web/                       React shell, routing, shadcn primitives, status page
  api/
    src/                     Bootstrap, config, errors, sessions, scoped orders/reservations
    prisma/                  29-model schema, seed and four SQL migrations
  worker/src/                Ping queue, worker bootstrap and smoke command
packages/
  shared/src/                Zod money/API/role/job/state contracts
  policy-engine/src/         Deterministic financial/permission primitives
  paypal-client/src/         Interfaces and Sandbox configuration schema only
scripts/                     Credential/bootstrap, storage, migrations and image-loading helpers
tests/
  integration/               Real database/RLS/session/ownership/concurrency/Redis tests
  e2e/                       Browser shell/status/failure tests
docs/                        Design, versions and this report
compose.yaml
pnpm-workspace.yaml
pnpm-lock.yaml
turbo.json
```

Ignored local artifacts include .env, .env.test, .local bootstrap credentials/image caches, generated Prisma clients, node_modules, build outputs and test traces. Generated development credentials are never printed or committed.

## Dependencies and versions

All direct dependencies are exact-pinned; all resolved dependencies are recorded in pnpm-lock.yaml. [VERSIONS.md](VERSIONS.md) lists every direct dependency by workspace.

| Component                                          | Version                           |
| -------------------------------------------------- | --------------------------------- |
| Node / pnpm / Turbo                                | 24.13.1 / 12.3.4 / 2.11.10        |
| TypeScript / ESLint / typescript-eslint / Prettier | 5.9.3 / 10.14.0 / 8.72.1 / 3.9.10 |
| React / Vite / React plugin                        | 19.3.1 / 8.3.7 / 6.3.0            |
| Tailwind / React Router / AG Grid Community+React  | 4.3.5 / 8.5.1 / 36.3.0            |
| Fastify / Zod                                      | 5.12.8 / 4.6.7                    |
| Prisma CLI+client+PG adapter / pg                  | 7.10.1 / 8.23.1                   |
| BullMQ / ioredis / Argon2                          | 6.7.2 / 6.0.0 / 0.45.2            |
| Vitest / Playwright                                | 5.1.0 / 1.65.0                    |
| PostgreSQL / Redis / SeaweedFS development images  | 17.6-alpine / 7.4.6-alpine / 4.12 |

Prisma 7 avoids a release-candidate latest tag; TypeScript 5.9 stays within the lint adapter's supported range. Explicit dependency-build policy permits required native build scripts and disables optional msgpackr-extract optimization. Compatibility was verified locally; package/image pins are not a vulnerability-free guarantee.

## Database tables and migrations

29 application tables: Merchant, User, Session, Membership, PaymentAccount, PolicyVersion, PolicyClause, Order, CustomerOrder, OrderItem, CheckoutOperation, Capture, Case, Evidence, EvidenceChunk, Analysis, Finding, FindingReference, Proposal, Approval, RefundOperation, PaymentAttempt, ExternalRefund, FormalDispute, WebhookInbox, WebhookReceipt, AuditEvent, OutboxEvent and IdempotencyRecord.

| Migration              | Changes                                                                                                                            | Result                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0001_foundation        | Tables, enums, uniqueness, FK indexes and 72 base FK constraints                                                                   | Applied to development and isolated test DB |
| 0002_security          | Financial/check constraints, partial indexes, immutability, tenant/customer RLS and runtime grants                                 | Applied to both                             |
| 0003_reservation_locks | Column-limited row-lock permissions, approver RLS and boolean original-approver validation                                         | Applied to both                             |
| 0004_relational_guards | Published-clause move/publication guard, same-case supersession, external refund account association and provider identity indexes | Applied to both                             |

Prisma models expose scalar fields; SQL owns relational foreign keys, RLS and additional guards. Do not use db push or regenerate already-applied migrations. Nullable typed evidence-reference FKs replace the original polymorphic source pointer. Compound relationships enforce same tenant, current proposal's case, refund's order/account/currency, and explicit customer ownership.

## Authentication, RLS and financial primitives

Opaque random session cookies use keyed-hash persistence, Argon2id passwords, HttpOnly/SameSite=Lax and production Secure. Sessions expire after eight hours absolute or thirty minutes idle; login rotates/revokes the prior session and logout revokes it. Origin checks protect login/mutations; session-bound CSRF tokens protect logout. Public signup/reset/MFA and a login UI are outside this phase.

Runtime roles cannot own tables, bypass RLS, create roles/databases/schema objects, or assume the migration role. Startup rejects privileged runtime credentials or missing tenant RLS. All 27 domain/root tenant tables have ENABLE and FORCE RLS; User and Session are trusted global authentication tables. Migration ownership has an explicit maintenance policy unavailable to runtime.

Membership and order-ownership discovery expose only the authenticated actor's bindings before tenant selection. Scoped repositories use Prisma interactive transactions with parameterized transaction-local user/merchant settings; tests verify cleanup after success, rollback and pooled reuse. RLS protects against omitted tenant filters, not stolen server credentials or arbitrary SQL execution by the trusted application role.

Internal reservation locks Capture -> Case -> Proposal, validates fresh approver authority/current consent/associations/expiry/balance, then atomically inserts the unique operation, increments reservation and appends audit. Parallel duplicate intent yields one operation/reservation; audit failure rolls back everything; UNKNOWN retains funds. There is no reservation HTTP endpoint, refund job, executable financial outbox delivery or provider call. Full policy-clause evaluation remains Phase 4, and external money execution remains Phase 7.

## Actual running services

| Service               | Address / state                                                                 |
| --------------------- | ------------------------------------------------------------------------------- |
| Web                   | http://localhost:5173 — HTTP 200                                                |
| API liveness          | http://localhost:3001/health — HTTP 200                                         |
| API readiness         | http://localhost:3001/ready — HTTP 200 with real DB/Redis checks                |
| PostgreSQL            | localhost:5432 — healthy, migrated                                              |
| Redis                 | localhost:6379 — healthy, password protected                                    |
| S3-compatible storage | http://localhost:9000 — healthy; both buckets created, anonymous listing denied |
| Worker                | Running; processed foundation.ping with a successful real smoke response        |

These states were observed during validation, not an availability guarantee. API/web/worker run through pnpm dev; Compose infrastructure persists until explicitly stopped. Local storage is SeaweedFS; no MinIO console or unauthenticated management port is exposed.

## Commands executed and outcomes

On Windows these used pnpm.cmd; README uses portable pnpm spelling.

| Command/check                                                              | Final result                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| node --version; pnpm.cmd --version; docker version; docker compose version | Tooling inspected                                                   |
| docker desktop start                                                       | Installed daemon started                                            |
| pnpm.cmd install; pnpm.cmd install --frozen-lockfile                       | Passed; exact lockfile saved                                        |
| pnpm.cmd local:init                                                        | Generated ignored local/test credentials/bootstrap                  |
| docker compose --env-file .env config --quiet                              | Passed                                                              |
| docker compose --env-file .env up -d --wait --pull never                   | Passed after verified local image imports                           |
| node scripts/load-local-images.mjs                                         | Official pinned blobs downloaded/loaded through host workaround     |
| pnpm.cmd --filter @resolveai/api exec prisma validate                      | Passed                                                              |
| pnpm.cmd db:generate                                                       | Passed                                                              |
| pnpm.cmd db:migrate; pnpm.cmd db:migrate:test                              | All four migrations succeeded                                       |
| node scripts/storage-init.mjs                                              | Two private buckets initialized; anonymous listing rejected         |
| pnpm.cmd db:seed                                                           | Development identities/owned unpaid orders seeded                   |
| pnpm.cmd format; pnpm.cmd format:check                                     | Passed                                                              |
| pnpm.cmd lint                                                              | Passed                                                              |
| pnpm.cmd typecheck                                                         | All apps/packages and test source passed                            |
| pnpm.cmd build                                                             | All six apps/packages passed; frontend chunk-size warning remains   |
| pnpm.cmd test                                                              | 17 unit tests passed                                                |
| pnpm.cmd test:integration                                                  | 27 integration tests passed using real PostgreSQL/Redis             |
| pnpm.cmd exec playwright install chromium                                  | Downloaded browser assets                                           |
| pnpm.cmd test:e2e                                                          | 2 browser tests passed with full Chromium headless channel          |
| pnpm.cmd queue:smoke                                                       | Actual separately running worker returned ok:true                   |
| pnpm.cmd --filter @resolveai/api exec prisma migrate status                | Schema up to date, no pending migration                             |
| HTTP checks + docker compose ps                                            | Web/health/ready HTTP200; all three infrastructure services healthy |

Final totals: **46 tests passed, zero remaining failing tests**. CI configuration exists but was not executed on GitHub; local checks were executed. No PayPal or OpenAI behavior was tested or claimed.

## Failures encountered and resolved

- Installation initially hit concurrent lockfile activity and an undeclared optional native script. Installation was serialized and the optional optimization explicitly disabled.
- Initial package tests ran before shared exports were built. Dependency-ordered builds/pretest scripts corrected this.
- Strict API error typing and one formatting mismatch failed early checks; corrected and rechecked.
- MinIO registry/pull attempts were denied. The local S3 service changed to SeaweedFS with verified configuration and private-bucket checks.
- Docker daemon image downloads failed with an HTTP/HTTPS proxy error. Host downloads plus local OCI digest registration worked without global Docker changes. Initial digest/reference and host-port setup failures were corrected; actual service connectivity was subsequently verified.
- Storage initialization initially raced service startup. Storage health now checks the S3 listener as well as the master service; initialization subsequently passed.
- Three reservation tests exposed missing row-lock privileges. Migration 0003 grants only the necessary version-column permissions under approver policies.
- Repeated test runs exposed leftover synthetic rows. The suite now resets only its isolated test database, validating both runtime and migration targets before destructive setup.
- Additional test-editing and startup catalog-query errors were corrected; startup inspection now excludes indexes and covers every tenant table.
- Chromium headless-shell timed out before page creation. The installed full Chromium headless channel passed both browser tests without loosening application assertions.

## Known limitations and security boundaries

- Vite reports a large initial frontend chunk because AG Grid Community is registered in the minimal shell. Route/module splitting remains a performance improvement; build succeeds.
- Compose image pins target linux/amd64 and are development-only. Review/update images and dependencies before any production use; no audit/certification is implied.
- Local S3 credentials have development admin permissions; production object access/encryption/rotation, evidence scanning and retention enforcement are not implemented here.
- No public identity lifecycle, MFA, legal/privacy review, seller onboarding, provider adapters, reconciliation, full policy resolver, outbox relay, complaint workflow or AI pipeline yet. These are explicit later-phase gates.
- Session/RLS context depends on trusted server code and protected environment/database credentials. Migration credentials must never be used by serving processes.
- Failed queue jobs remain bounded/inspectable; delivery is at least once. Harmless repeated ping processing has no financial side effect.
- Local infrastructure uses HTTP/loopback bindings; production TLS/network/backup/restore/monitoring requirements remain outstanding.

## Architecture document changes

README now contains actual setup/check commands and service addresses; AGENTS records authorized Phase 2 scope. ARCHITECTURE documents local storage and scalar persistence choices. DATABASE records typed references, same-parent FKs, transaction-local discovery, maintenance policy and row-lock privileges. API distinguishes implemented auth/order routes and UUID cursor paging from future contracts. SECURITY records fixed session durations, global-auth trust boundaries and local-storage limitations. PAYPAL explicitly states contracts-only/no calls. TEST-PLAN maps executable checks; ROADMAP records scope adjustments. VERSIONS lists exact direct pins; .env.example includes required local settings and optional disabled future integrations.

## Recommended next phase

Phase 3: verified PayPal Sandbox OAuth/order/capture adapters, durable checkout operations, outbox/inbox handling, account/amount/currency association and recovery tests. Confirm current endpoint schemas, account authorization, event names and idempotency retention before implementation. Keep refunds, AI and complaint workflows behind their later dependencies; do not equate synthetic capture fixtures with verified Sandbox payments.
