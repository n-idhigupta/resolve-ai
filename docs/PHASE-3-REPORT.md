# Phase 3 completion report

Date: 2026-11-09.

**Status: Sandbox checkout/capture and signed webhook verification confirmed.** See the 2026-11-10 hardening evidence below. The original implementation-only results are historical; current production limitations remain.

## Implemented features and modules

- `packages/paypal-client`: injected, typed Sandbox transport; single-flight OAuth caching and refresh; create/capture/order lookup/capture lookup/signature verification; bounded responses, timeouts and normalized errors.
- `packages/payment-store`: transactional payment intents, fenced leases, server-side financial verification, atomic settlement, encrypted webhook receipts, durable outbox delivery and inbox processing, reconciliation and database privilege checks.
- `packages/shared`: explicit payment-state contracts and monotonic transition rules. Existing financial reservation and authorization primitives remain in place.
- `apps/api/src/payments.ts`: customer-owned checkout, capture and status routes; public configuration; bounded webhook ingress. Existing authentication, CSRF, Origin checks and order modules are reused.
- `apps/worker/src/payment-worker.ts`: payments queue, assigned-account tenant access, durable recovery sweeps and graceful shutdown. Existing harmless queue remains available.
- `apps/web/src/checkout.tsx` and `paypal-sdk.ts`: customer login/orders, official Sandbox JavaScript SDK v6 approval, cancellation/error handling, capture request and verified transaction status.
- `scripts/provision-payments.mjs`, `configure-paypal.mjs` and `sandbox-smoke.ts`: least-privilege local roles, explicit account binding and opt-in real-provider testing.
- New provider, state-machine, database/API/concurrency and browser tests; CI and environment configuration updated.

The monorepo now contains three applications and four packages. `payment-store` is a shared internal persistence boundary used by API and worker, avoiding duplicated financial state logic. No refunds, AI, complaint workflows or formal dispute execution were implemented.

## Database and migrations

The existing 29 Prisma models are retained. Four additive SQL migrations were applied successfully to development and isolated test databases; all eight migrations are current:

| Migration                | Changes                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0005_checkout_delivery` | Assigned payment accounts, order payment state, immutable checkout intent and provider observations, verification timestamps, receipt deduplication, outbox leases, scoped worker/customer policies and narrowly privileged receipt ingress. |
| `0006_payment_retry`     | Bounded mutation attempts and receipt limits that allow genuine delivery after rejected forged receipts.                                                                                                                                     |
| `0007_customer_outbox`   | Customer SELECT policy limited to owned checkout outbox rows, needed for safe conflict handling.                                                                                                                                             |
| `0008_execution_guards`  | Assigned-worker merchant-status access and item immutability checks against both old and new parent orders.                                                                                                                                  |

Prisma generation succeeded. SQL remains authoritative for RLS, composite constraints and immutable-field protections. Runtime roles are separate from migration ownership.

## Provider and application endpoints

Provider calls use only the fixed Sandbox origin:

- POST `/v1/oauth2/token`.
- POST `/v2/checkout/orders` and GET `/v2/checkout/orders/{id}`.
- POST `/v2/checkout/orders/{id}/capture`.
- GET `/v2/payments/captures/{id}`.
- POST `/v1/notifications/verify-webhook-signature`.

ResolveAI exposes `/api/v1/paypal/config`, `/api/v1/orders/:orderId/checkout`, `/api/v1/orders/:orderId/capture`, `/api/v1/orders/:orderId/payments`, `/api/v1/payment-operations/:operationId` and `/api/v1/webhooks/paypal/:accountKey`. Existing `/api/v1` conventions are preserved. See [API contracts](API.md) and [verified official references](PAYPAL.md).

## Payment state, idempotency and recovery

Order business status remains separate from payment progress. Payment progress includes PENDING, CREATED, AWAITING_BUYER_APPROVAL, APPROVED, CAPTURE_PENDING, CAPTURED, FAILED, CANCELLED and RECONCILIATION_REQUIRED. Browser cancellation is advisory and does not falsely establish provider cancellation. Durable CREATE/CAPTURE operation status records execution, uncertainty and completion separately.

One immutable logical operation exists per order and kind. Actor/route/key/body replay checks, database uniqueness, row locks and leased token-fenced commits prevent duplicate local execution. Server item totals, merchant, USD currency and provider association are validated; frontend amounts are never accepted. Returned provider order IDs are durably observed before follow-up verification, but are not exposed as verified checkout until that verification completes.

Completed settlement requires authoritative order/capture identity, seller, gross amount and currency checks. Unique capture persistence, operation completion, Order.PAID and audit are committed atomically. No database transaction spans a provider or queue network call. Stale create/webhook work cannot overwrite newer capture progress.

Mutation retries preserve the original provider request ID and payload. The conservative deadline is 21,300 seconds, below the documented six-hour retention, with at most five mutation attempts. This implementation does not assume indefinite PayPal idempotency. Timeouts become UNKNOWN/reconciliation-required; known IDs are retrieved before any safe identical retry. After the deadline, reads may continue but no replacement key is generated. Unknown creation without a recoverable provider ID requires manual investigation.

## Durable delivery, inbox and least privilege

Outbox events are leased with SKIP LOCKED and marked delivered only after queue acknowledgment. Delivery may repeat. Independent database sweeps rediscover due operations and unverified or verified-but-unfinished receipts after queue loss or worker restart. Workers claim execution with 90-second leases and token-fenced database commits. BullMQ retries are bounded and failed jobs retained for inspection; no exactly-once delivery claim is made.

Webhook ingress atomically persists inbox, encrypted original receipt and outbox work through a narrowly granted SECURITY DEFINER function with fixed search_path. Required headers and payload sizes are validated. Signature verification precedes effects, and event resource GETs independently verify financial identity. Duplicate and out-of-order events cannot establish payment from event names alone. A rejected forged receipt cannot permanently poison a later valid delivery. Provider-observed reversal freezes settlement for review without executing a refund.

Dedicated `resolve_payments` and `resolve_payments_test` roles are nonowner, nonsuperuser, NOBYPASSRLS, without role membership or schema creation. PaymentAccount assignment limits discoverable tenants; transaction-local tenant context plus FORCE RLS limits each operation. Workers cannot read User, Session, RefundOperation or complaint/proposal records. Startup checks reject unsafe worker privileges. RLS is a database boundary for trusted scoped services, not protection against a database administrator or stolen credentials within their assigned privileges.

## Commands and validation results

Executed during implementation: dependency installation and frozen-lockfile verification; `pnpm db:provision-payments`; `pnpm db:migrate`; `pnpm db:migrate:test`; `pnpm db:generate`; `pnpm db:seed`; Prisma migration status; `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm build`; `pnpm test`; `pnpm test:integration`; `pnpm test:e2e`; `pnpm check`; and `pnpm queue:smoke`. Documentation formatting was run after report creation. Official provider contracts were consulted; documentation review is not live API verification.

| Check                                 | Final result                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Formatting, lint and strict typecheck | Passed                                                                                                |
| Seven workspace builds                | Passed                                                                                                |
| Unit tests                            | 32 passed                                                                                             |
| Integration tests                     | 55 passed, actual PostgreSQL/Redis with mocked PayPal transport                                       |
| Browser tests                         | 6 passed; checkout SDK/provider behavior mocked, local shell/status exercised                         |
| Harmless queue smoke                  | Passed with actual Redis and worker                                                                   |
| Payment queue/restart/recovery        | Passed in integration using actual database role and BullMQ with mocked provider                      |
| Real Sandbox smoke                    | Dedicated smoke command not run; real existing order/capture and signed events independently verified |

Final automated total: **93 passed, zero failed**. Coverage includes ownership and tenant denial, unsafe worker privileges, duplicate/concurrent operations, frozen amounts, provider identity/amount/currency mismatches, timeout recovery, expired leases, durable queue retry, forged/duplicate/stale webhooks and verified-receipt recovery. Existing authentication, reservations and tenant-isolation tests also pass.

Earlier failures were corrected before final validation: outbox RLS conflict visibility, a UUID/text audit parameter cast, an acknowledgment-loss test expectation, unused imports and root script dependency declaration. Additional regressions cover preserving observed provider IDs, monotonic recovery, malformed verification versus OAuth failure handling and mismatched authoritative order IDs. The frontend build retains a nonfatal large-chunk warning from the existing AG Grid bundle. GitHub-hosted CI was configured but not executed here.

## Local services

At validation, the development web server was reachable at http://localhost:5173/checkout and API health/readiness at http://localhost:3001/health and http://localhost:3001/ready. PostgreSQL 5432, Redis 6379 and private S3-compatible development storage 9000 run through the existing loopback-bound Compose setup. These are local development services, not deployed services. Payment execution is disabled until explicit Sandbox configuration; the running harmless queue does not imply configured PayPal processing.

## Manual checkout and real-provider gate

1. Follow README infrastructure/setup commands; provision payment roles before applying Phase 3 migrations, then seed development orders.
2. Create a Sandbox Business seller/app and separate Personal buyer. Obtain the app client ID/secret, seller merchant ID and webhook ID.
3. Provide a publicly reachable HTTPS tunnel to the local API and register `/api/v1/webhooks/paypal/demo-sandbox` on that same app with the events listed in [PAYPAL.md](PAYPAL.md).
4. Set ignored local Sandbox settings, tenant/account binding, receipt encryption key and provisioned worker connection as specified in that document. Only the public client ID is exposed to the browser; never expose the secret.
5. Run `pnpm paypal:configure`, restart `pnpm dev`, open `/checkout` and sign in as `customer@resolveai.test` using the generated local seed password.
6. Select an unpaid owned order and approve with the Personal buyer. Confirm the UI displays a verified capture and check the actual seller transaction and webhook delivery.
7. Repeat/reload to verify stable local operation/capture identity. Exercise a recoverable interrupted response and confirm reconciliation.
8. Optionally run `pnpm test:sandbox` with explicit `RUN_PAYPAL_SANDBOX=true` and the required local order/login configuration. It pauses for buyer approval and writes a scrubbed provider-confirmed result only after success.

`pnpm paypal:configure` was executed to correct webhook metadata. The dedicated `pnpm test:sandbox` command was not run; the existing real payment was independently verified without initiating another charge. Full configuration and official account links are in [PAYPAL.md](PAYPAL.md).

## Documentation changes, limitations and next phase

README, AGENTS, ROADMAP, ARCHITECTURE, DATABASE, API, SECURITY, TEST-PLAN, PAYPAL, VERSIONS and `.env.example` reflect the implementation. Changes clarify assigned-account worker access, durable recovery, current SDK integration, immutable intent and bounded provider retries. Dependency versions remain pinned; the full direct-dependency inventory is in [VERSIONS.md](VERSIONS.md).

This release supports USD, one configured Sandbox seller, one purchase unit and one full capture. It deliberately does not generate replacement payable provider orders after failure/uncertainty. Account binding and tunnel setup are manual. One real SDK checkout and signed webhook path is verified; broader browser/account coverage and provider failure classification still need further testing. OAuth caching is process-local. Production monitoring, retention/cleanup, encryption-key rotation and broader operational review remain deployment prerequisites. No live-money environment is supported by this phase.

Proceed to Phase 4 customer complaints, policy versioning and evidence ingestion using the existing tenant/session/audit primitives, before adding AI or refund execution. The dated Sandbox evidence below supersedes the original pending gate.

## 2026-11-10 checkout hardening and real Sandbox evidence

The existing order `1PW94653MW830523X` and capture `7ND54081CF0194732` were independently retrieved using authenticated PayPal GET endpoints. Both returned COMPLETED, USD 100.00, with CAPTURE intent and the configured seller. Capture time was 2026-11-09T18:24:35Z. The local order is PAID/CAPTURED and reconciliation CURRENT. Successful diagnostic GET debug IDs were f21021240c8d8 and f63983732d09c. Those are lookup IDs, not the original popup error ID.

A real Chromium check authenticated against the local API, loaded the existing order and refreshed the checkout page. CAPTURED and the correct capture ID remained visible, with the pay button disabled. Checkout and capture request paths were blocked by that browser diagnostic; zero payment mutations were attempted.

The original PAYPAL_WEBHOOK_ID incorrectly contained a URL. Real verification failed HTTP400 with an alphanumeric-format error. The actual registered webhook was retrieved from the same Sandbox app and its ID corrected in ignored .env and PaymentAccount configuration. Its destination host is special-books-jade-geographical.trycloudflare.com, path /api/v1/webhooks/paypal/demo-sandbox. Both CHECKOUT.ORDER.APPROVED and PAYMENT.CAPTURE.COMPLETED deliveries were present. PayPal verified their original stored signatures successfully after configuration correction.

PayPal's authenticated resend endpoint redelivered those existing events through the configured tunnel. These were genuine signed notifications, not simulator events or fabricated POST bodies. Both inbox events reached VERIFIED/PROCESSED. Old rejected receipts remain preserved; newly signed receipts recover the same provider event identity. Receipt processing was repeated with a guarded transport that forbids order/capture mutation endpoints. Repeats did not create a duplicate capture or repeat inbox processing/audit effects. The capture's version remained zero and verifiedAt unchanged; CREATE and CAPTURE each retained postAttempts=1. The tests did not initiate another charge.

SDK v6 popup sessions now explicitly set commit:true, matching its documented default. The Orders request remains CAPTURE with server-frozen full amount. No redirect-only payment_source/return_url/cancel_url settings were added: the working session is callback-driven, and adding a redirect experience solely to force PAY_NOW would mix flows without demonstrated need. Future redirect support requires a separately designed return/resume contract. Contract reviewed: https://developer.paypal.com/sdk/js/reference/ .

SDK onError now preserves only bounded code/debug/correlation identifiers, a controlled description and timestamp in sessionStorage key resolveai.paypal.lastError and a sanitized console warning. Raw provider messages, payloads, URLs, tokens and stacks are excluded. Session storage may be disabled and is not centralized telemetry. The raw original popup error was not retained and its exact cause is still unknown. The later successful payment does not establish that the original popup problem can never recur.

API and payment-worker configuration now reject a webhook URL used as an ID, with a unit regression. New tests also cover redaction, explicit commit and paid-order refresh. Current validation: 32 unit, 55 integration and 6 browser tests pass; formatting, lint, typecheck and seven builds pass. Provider failures, races and recovery remain mocked-provider tests against real local infrastructure; the real evidence above covers one successful Sandbox transaction and signed approval/completion events, not live money or every failure scenario. An initial test import-extension typecheck failure was corrected before the successful runs.

The previous integration-ready gate is satisfied for the demonstrated Sandbox path. Phase 3 is complete for the demonstrated Sandbox scope; the final pnpm check run passed. No new schema migration was needed for this hardening. Production monitoring, secret rotation, receipt retention, broader account/country/browser testing and live-payment review remain outside this completion. Restart pnpm dev after editing ignored .env so API and worker reload configuration; never restart a payable intent by minting a new provider key.

Final database evidence: both real inbox events are VERIFIED/PROCESSED, attempts=1 each, with two processing audit events total. Exactly one capture remains, version=0. The registered webhook includes approval, completed, pending and legacy DENIED event subscriptions; DECLINED/reversal notification coverage was not exercised and subscription review remains an operational follow-up. These checks do not establish broader failure-event coverage.
