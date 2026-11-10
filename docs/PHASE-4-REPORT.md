# Phase 4: complaints, evidence and merchant policies

Date: 2026-11-10 (Asia/Calcutta).

**Status: complete for the documented local/Sandbox Phase 4 scope.** Real evidence scanning, tenant isolation, storage races and the customer-to-merchant browser journey are verified. This is not production or live-money approval.

## Implementation

Three applications now share five internal packages. New `packages/case-store` owns transactional complaint services, evidence processing, private storage and the scanner boundary. Shared Zod contracts and pure eligibility/lifecycle functions remain in shared/policy-engine. Fastify registers complaint, evidence and policy routes; the existing worker hosts a separately scoped evidence queue. React provides customer orders/complaints and a merchant workspace with AG Grid Community and owner policy management.

No AI, binding offers, financial resolutions, refunds or formal PayPal disputes were added. Existing checkout, capture, webhook and reconciliation handlers were retained. These are internal ResolveAI complaints.

### Lifecycle and repeat limit

- Owned, verified PAID/CAPTURED orders with CURRENT reconciliation are eligible, subject to purchase-policy rules and an active merchant.
- OPEN -> INVESTIGATING: merchant begins review.
- OPEN/INVESTIGATING -> AWAITING_CUSTOMER: merchant asks a customer-visible question.
- AWAITING_CUSTOMER -> INVESTIGATING: owning customer explicitly responds.
- Merchant closure or customer withdrawal -> CLOSED_WITHOUT_AGREEMENT, with a reason.
- CLOSED_WITHOUT_AGREEMENT is explicitly nonfinancial: no refund, settlement or payment is issued. No Phase 4 action sets RESOLVED or reopens a closed case.
- One active case per order remains enforced by the existing partial unique index. Maximum three complaints per order over its lifetime; a new complaint requires at least 24 hours since the latest closure. These limits are serialized under the order lock and shown by eligibility responses/UI.
- Expected versions and permitted actor/source states are checked. Comments, transitions, timeline/audit and idempotency results commit together. Exact retries preserve the original result; changed intent conflicts.

### Policies

Only OWNER edits/validates/publishes drafts. Publication creates new immutable version/clause rows with a content hash, serial sequence and publication time. Published drafts freeze too. Existing cases reference the order's purchase policy and store the evaluated snapshot/engine version; later publication does not change existing orders or cases.

Rules include categories, windows, evidence requirements, allowed remedies, potential amount/partial-percentage caps and human-review thresholds. Intersecting restrictions use the strictest compatible values; no rule authorizes money execution.

The existing synthetic purchase policy has no clauses. Its explicit legacy fallback permits intake but requires human review and implies no financial entitlement. The UI explains this; the immutable submission timeline/audit records the fallback. Evidence requirements remain outstanding review requirements rather than blocking case creation before uploads are possible.

### Evidence and scanner

Allowlisted JPEG, PNG, PDF and UTF-8 text, up to 10 MiB/file and ten non-expired slots/case. Image decoding is limited to 20 million pixels; PDFs reject encrypted/active-content/unsupported structures and more than 100 pages. Filename, extension and detected/parsed type are checked independently of client MIME.

The implementation deliberately uses bounded authenticated binary uploads through Fastify instead of presigned browser PUT. This avoids relying on unverified SeaweedFS conditional overwrite/checksum semantics. The API buffers at most 10 MiB per upload, so memory/concurrency limits require further review before public deployment. All object keys are server-generated and private.

Reservation -> UPLOADING -> UPLOADED -> QUEUED -> PROCESSING -> AVAILABLE. A verified size/SHA-256 receipt is required before scheduling. The worker retrieves and hashes the object again, scans actual bytes with ClamAV INSTREAM, validates content in a child process, then promotes to a distinct clean key. The parser child has a 128 MiB V8 heap cap and ten-second timeout; this is process isolation, not an OS sandbox or a total native-memory guarantee.

Only actual successful scans with signature databases no older than seven days allow CLEAN. Scanner outages/stale signatures retain quarantine and block downloads. EICAR is rejected by the real scanner. CLEAN database rows require scanner identity/time and a clean object key. Published clean evidence identity is immutable.

Downloads reauthorize the case and stream the clean object as an attachment with nosniff and no-store; no storage credentials, object keys or presigned URLs are returned. The implementation does not provide inline PDF execution/viewing or document extraction.

### Durability and least privilege

The separate resolve_evidence/resolve_evidence_test database roles are nonowner, nonsuperuser, NOBYPASSRLS, without role membership/schema creation. EvidenceWorkerTenant explicitly assigns tenants. Every operation establishes transaction-local tenant context; startup verifies forced RLS. The evidence role cannot read authentication, capture or refund tables, and can see only evidence-specific outbox events.

The evidence queue leases database work, acknowledges outbox delivery only after queue acknowledgment, and independently sweeps due evidence. Expired processing leases recover after worker restart. Jobs carry identifiers only, retry three times exponentially and retain failures for inspection. Provider/payment mutation methods are not part of the evidence handler.

The development worker process hosts payment and evidence handlers with separate database clients; this does not provide OS/process isolation of their environment credentials. Production process/secret separation remains a deployment task.

Promotion attempts persist their object keys before network writes. Lost-lease attempts cannot publish and remove only their own object; cleanup rediscovers recorded orphan keys without deleting the committed clean object. Abandoned uploads expire after 24 hours; rejected/failed objects are cleaned after seven days. Metadata/history remains. Accepted evidence has no automatic retention deletion in this phase.

## Database and changed modules

Additive migrations applied to development and isolated test databases:

| Migration               | Purpose                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0009_complaints         | Case fields/category/information-request state; comments/timeline/drafts/worker assignment; scoped customer and owner policies |
| 0010_evidence_worker    | Dedicated evidence-role grants and assigned-tenant RLS                                                                         |
| 0011_case_guards        | Scanned-before-clean constraint, immutable case identity/published drafts, indexes and evidence-only outbox access             |
| 0012_evidence_artifacts | Durable promotion keys and scanned-evidence immutability                                                                       |

Four new tables bring the Prisma model count from 29 to 33. Existing tables, capture identities, financial counters and payment migration history were not recreated.

New/updated areas: case-store; shared/policy-engine complaint contracts; API cases/bootstrap; evidence worker/bootstrap; React complaints/routes; role/configuration/image scripts; Compose/CI/environment examples; unit/integration/browser tests; README and architecture/API/database/security/test/roadmap/version documentation.

## Commands and results

Executed: pinned dependency installation; evidence-role provisioning and explicit tenant assignment; development/test migrations and Prisma generation; scanner image download/load and Compose startup; dependency builds; lint/typecheck/format checks; integration/browser runs; full pnpm check; read-only verification of the existing payment.

The initial direct Docker pull failed with the existing daemon HTTPS/proxy error. The digest/checksum-verified OCI fallback loaded the official image and the ClamAV container became healthy. The fallback script was also executed successfully with its fixed digest.

Initial failures were not skipped: stale shared-package build exports, a TypeScript definite-assignment check, intentional control-character lint rules, a missing caught-error cause, isolated browser proxy cookies, accessible select names, and excessive multi-request detail polling were corrected. Detail polling is now one authorized aggregate response every ten seconds; rate limiting remains enabled. The browser journey subsequently passed with actual API/database/storage/scanning.

The final `pnpm check` command exited successfully:

| Check                                      | Actual result                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Frozen dependency installation             | Passed                                                                                                   |
| Formatting and lint                        | Passed                                                                                                   |
| Strict application/package/test typechecks | Passed                                                                                                   |
| Eight workspace builds                     | Passed                                                                                                   |
| Unit tests                                 | 37 passed                                                                                                |
| Integration tests                          | 70 passed, including actual PostgreSQL/RLS, Redis, SeaweedFS and ClamAV                                  |
| Browser tests                              | 8 passed, including the actual isolated customer/merchant/scanned-evidence journey and owner publication |
| Scanner                                    | ClamAV 1.5.4, database 28177 dated 2026-11-08; PING returned PONG; clean and EICAR tests passed          |
| Migration deployment                       | All 12 migrations applied; four are Phase 4 additions                                                    |
| Existing real payment                      | Unchanged verified capture, amount, counters and version                                                 |

Total: **115 automated tests passed; zero failed in the final suite.** The original Phase 2/3 tests pass too. Failure/concurrency payment tests remain mocked provider tests; Phase 4 did not initiate another Sandbox charge. Recovery coverage uses expired processing leases and actual BullMQ startup/sweeping; it does not claim an OS crash campaign. GitHub-hosted CI was configured but not run here.

The original shell heading regression was restored to preserve the existing browser contract. Final extra UI typechecking passed after timeline actor labels were added. Large frontend-bundle warnings remain nonfatal; no production performance/accessibility audit is claimed.

## Exact local setup and demo

For this existing workspace, keep .env and existing Docker volumes; do not run local:init again.

```powershell
pnpm install --frozen-lockfile
pnpm infra:up
pnpm db:provision-evidence
pnpm db:migrate
pnpm db:migrate:test
pnpm evidence:configure
pnpm scanner:up
pnpm dev
```

For a fresh checkout, follow README bootstrap first and provision both payment and evidence roles before migrations; seed development identities before evidence:configure. If the Docker daemon cannot download the scanner image, run pnpm scanner:load-image, then pnpm scanner:up. Initial scanner startup may take time to load/update signatures. Scanner port 3310 is loopback-only, with a persistent signature volume. The helper enables evidence processing and assigns only the two seeded local tenants; real deployment provisioning must be explicit.

1. Open http://localhost:5173/orders. Sign in as customer@resolveai.test with root .env DEV_SEED_PASSWORD; no password is committed or printed.
2. Select the existing captured USD100 order 30000000-0000-4000-8000-000000000001. Open an internal complaint, select a category, enter title/description and requested outcome. Observe the legacy-policy notice.
3. Submit and attach a small .txt, JPEG, PNG or PDF. Observe quarantine/queued status, then available/clean only after successful real validation/scanning. Download the authorized evidence.
4. In a separate browser profile/context, sign in as support@resolveai.test. Open Merchant Cases, find the case, add a private note and customer-visible response, and request additional information.
5. Refresh the customer view: the private note must remain absent. Respond to the information request and verify the timeline.
6. Close from the merchant workspace with a reason. Both views explain that closure issued no refund or settlement. Further comments/uploads are blocked.
7. Sign in as admin@resolveai.test, open Policies, save/validate/publish a draft and inspect published history. Existing case/purchase snapshots remain unchanged.
8. To demonstrate outage behavior, stop only the optional scanner: docker compose --env-file .env --profile scanner stop clamav. New evidence must remain unavailable; restart with pnpm scanner:up. Do not stop the scanner while the automated suite is running.

The case/order limit applies to repeated real demos too. Do not reset the captured payment or bypass the cooldown. Use isolated test fixtures for repeated automated demonstrations.

Verification command: pnpm check. Tests require PostgreSQL, Redis, private storage and healthy ClamAV; unavailable prerequisites fail instead of silently skipping. Browser complaint tests route to a separately listening isolated test API and synthetic captured-payment fixture; they make no real PayPal requests. Test storage cleanup deletes only generated keys represented by the isolated test database.

## Preserved payment and limitations

The real capture 7ND54081CF0194732 remains COMPLETED, USD100, reserved/refunded zero, version0 and original verifiedAt 2026-11-09T18:24:39.050Z. No new order or capture was initiated by Phase 4 verification. A read-only authenticated eligibility request against that real order returned HTTP200, eligible=true, legacy=true and caseCount=0. The customer complaint journey is automated against an isolated synthetic capture; the local real captured order remains available for the manual demo.

ClamAV does not guarantee absence of all malware. Document validation is intentionally limited; unsupported content stays unavailable. No legal adjudication, public onboarding, notifications, automated closure, production object-retention/erasure policy, distributed secret isolation or live-money operation is claimed. Background cleanup is eventually consistent. The source image is pinned, while scanner signature data must remain current rather than reproducibly frozen.

Next: Phase 5 evidence intelligence with strict citation/snapshot boundaries and manual-review fallback. AI must never change these authorization, evidence-cleanliness or financial invariants.
