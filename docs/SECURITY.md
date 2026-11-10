# Security model

Protect funds, capture ownership, evidence/PII, approvals, secrets and audit integrity. Actors include malicious customers, compromised merchant accounts, malicious documents, webhook forgers and dependencies. Browser/uploads/model/event payloads are untrusted until independently validated; authenticated provider reads still require account/resource association.

| Threat                   | Controls / verification                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant IDOR              | Composite tenant FKs, RLS with nonowner runtime role, scoped repositories, customer ownership on every nested object/download; two-tenant tests.                      |
| Unauthorized refund      | Approver permission, fresh login, exact both-party consent/hash/expiry/policy, server-selected capture and deterministic recheck; no AI execution tool.               |
| Replay/double spend      | Unique operation/proposal, immutable provider key/body, row-locked reservation, dedupe, outbox and frozen UNKNOWN.                                                    |
| Forged checkout          | Server totals/payee and authenticated capture verification; return URL never proof.                                                                                   |
| Forged/reordered webhook | Preserved raw receipts, official signature verification, account match, dedupe and GET on conflict; invalid-first delivery cannot poison authentic receipt.           |
| Injection/hallucination  | No tools/secrets, strict schema, source/range validation, deterministic constraints and human review.                                                                 |
| Malicious upload         | Quarantine, magic bytes, size/count/page limits, malware scan, immutable object-version/hash, resource-limited network-disabled parsing; reject SVG/HTML/executables. |
| XSS/SSRF                 | Escape text, no unsanitized HTML, isolated safe PDF viewer, CSP, attachment headers, no user/model URL fetch.                                                         |
| Session/CSRF             | Hashed opaque tokens, secure cookies, Origin+CSRF, expiry/revocation, Argon2id, login throttling and fresh refund auth.                                               |
| Insider misuse           | Least privilege, owner-only policy, immutable audit/consent; production MFA and access monitoring.                                                                    |
| Queue forgery            | Private authenticated Redis, IDs-only validated payloads, persisted entity/tenant/state checks; queue fields cannot authorize money.                                  |
| Secret leakage           | Managed secrets, environment separation, no secret VITE variables, redacted logs, dependency/secret scanning.                                                         |
| Cost/availability        | Per-user/tenant quotas, bounded extraction/model work, retry ceilings/backpressure and manual fallback.                                                               |
| Audit tampering          | Append-only DB permissions/triggers; restricted exports and future immutable external copy. Demo does not resist DB-admin tampering.                                  |

## Data handling

Private encrypted storage/TLS; quarantine and clean access separated. Random keys and version/hash-bound reads prevent post-scan overwrite. Signed upload5m, download60s; authorize each request, never log/cache signed URLs. Already-issued URL cannot be instantly revoked; short TTL limits exposure.

Synthetic-demo defaults: incomplete/quarantine expires24h; clean evidence/extraction30 days after closure; audit/financial metadata1 year. These are operating defaults, not legal advice. Production lawful basis, notices, jurisdiction, retention/erasure exceptions, regional storage and processor terms need review. Deletion retains minimal tombstone/hash/audit, not document text. Backups have explicit expiry and protected restore; no immediate-backup-erasure promise.

Log IDs/transitions/timing/scrubbed errors, never passwords/tokens/raw prompts/evidence/provider payloads. Encrypt raw webhook receipt storage with restricted access/retention. Customer timeline filters internal audit. CSV exports escape formula-leading cells and enforce tenancy; no AG Grid Enterprise assumption.

Before live funds: TLS/CSP, scoped process secrets, rotation, maintained scanner, verified identity/reset/recovery/MFA, managed backups/restore drill, reconciler/alerts, dependency/security review and legal/privacy approval. No compliance/certification claim. Financial incident freezes affected capture and alerts operators; never clear uncertainty by sending a new request key.

## Phase 2 operational boundary

Session durations are fixed at eight hours absolute/thirty minutes idle; fresh financial authorization is fifteen minutes. No production seed, signup/reset/MFA or public login UI. Cookie Secure is enabled for production; development uses localhost HTTP. Global User/Session persistence is trusted authentication infrastructure; tenant RLS protects domain tables. Database credentials and actor context remain server-only. Generated local S3 credentials have development admin access; production storage encryption/access policies and evidence scanning are not implemented in Phase 2.

## Phase 3 payment controls

Use dedicated assigned-account worker roles and encrypted receipt ingress; no RLS bypass or migration credential is used by serving processes. Worker startup rejects privileged roles and missing payment RLS. Customer initiation remains ownership-gated; workers execute only persisted immutable intents, never queue-supplied money/payee/credentials. A forged queue tenant cannot broaden database access.

Webhook JSON remains untrusted after receipt. Verification uses the configured app webhook ID and original event formatting, then authenticated order/capture GET checks seller, amount, currency and association. Raw receipts use AES-256-GCM with a shared private 32-byte API/worker key. Cert URLs are allowlisted metadata only; no arbitrary server URL fetch. Logs/DTOs omit raw provider bodies, secrets, credentials and session material.

Stable keys, fenced commits, unique captures and atomic financial state prevent local duplicate intent/settlement. Unknown results do not mint another provider order. No refund or dispute executor exists. Client cancellation cannot negate an in-flight provider result. Receipt pruning, production key rotation and stronger account/process isolation remain release gates; do not infer compliance or production readiness from deterministic tests.

## Phase 4 controls

Customer ownership is checked for every case/evidence parent. Internal notes/timeline rows have merchant-only SELECT policies. Case identity/purchase snapshots and append-only history are SQL protected. Worker evidence credentials are distinct from payment credentials and restricted to explicitly assigned tenants without RLS bypass; the current development process still hosts both handlers.

Untrusted content remains private/quarantined until real ClamAV scanning, freshness checks, hash/type/structure checks and fenced promotion finish. Parsing is in a timed child process with a V8 heap limit; this is not an OS sandbox. Download attachments are reauthorized, hash checked and nosniff/no-store. Keys and credentials are never DTO/log fields. Durable promotion-key tracking allows orphan cleanup after crashes; cleanup respects active leases and never deletes the committed clean object. See PHASE-4-REPORT.md for verified race tests and deployment limits.

## Phase 5 threat controls and limitations

Customer/merchant prose, PDFs, screenshots and model output remain untrusted. No model tools, secrets, URLs or financial authority exist. Explicit redaction and source allowlists exclude private notes. Strict output, typed citations, conservative policy candidates and identical review/revision checks constrain effects; they do not prove model factual correctness.

Each customer consent binds exact request bytes/derivatives, source manifest and immutable sharing policy. External token counting also requires consent. Revocation prevents later authorized dispatch and review; already authorized/in-flight transmissions cannot be recalled. store:false is not a zero-retention promise. Preview explicitly warns that image personal data may remain.

Separate inference role/process has assigned-tenant FORCE RLS, no payment/auth/original evidence grants and no PayPal/storage environment credentials. Narrow freshness/retention functions check tenant assignment using session_user, fixed search_path and revoked PUBLIC execute. Local process credential separation is not a complete compromised-host sandbox; production requires independent OS/container identities, filesystem/egress controls, KMS, provider contractual/privacy review and operational key rotation.

AES-GCM artifacts use a separate private AI_ARTIFACT_KEY. Local payload retention30days, immutable hashes/audit retained. Cleanup requires running inference sweeper. Usage holds, per-tenant serial inference, five starts/minute, fixed token caps and bounded retries limit cost. Unknown outcomes retain holds. No raw prompts, extracted evidence, provider error payloads or credentials enter logs. Citation-valid prose still requires human factual review; malicious markup renders as text.

## Google unpaid-service boundary

Google's provider-specific disclosure and consent hash are distinct from OpenAI. Unpaid mode prohibits personal/sensitive/confidential submissions, even with consent; only trusted synthetic fixtures bound to their Case version may proceed. Ordinary content/version changes invalidate that authorization. The Gemini key is filtered from API/legacy payment dotenv loading and passed only to the selected restricted inference child. SDK errors are normalized without raw vendor messages/URLs; SDK retries are disabled and response size/timeout bounded. Unexpected models and the documented rerouting cutoff fail closed. Real-provider requests remain explicitly deferred. This is application/process credential separation, not OS filesystem isolation; existing deployment-isolation limitations remain.

## Negotiation milestone A

Treat client-provided terms, hashes, expiry and actor claims as untrusted. Strict discriminated contracts reject execution fields and client status changes; actor identity comes from the session. Case locks, case If-Match and permanent actor/route/body idempotency prevent conflicting retries. Immutable Proposal content hashes bind exact terms, source context and purchase-policy version. OWNER/APPROVER publication is explicit human review, not financial authorization. Deterministic integer caps and clean-evidence requirements apply to merchant drafts and customer counters; replacement additionally requires explicit permission in applicable immutable purchase clauses.

FORCE RLS hides unpublished merchant drafts, including withdrawn drafts, from customers. Append-only publication receipts authorize historical customer visibility; counters belong to the case customer. Private merchant comments remain separate from negotiation discussion. Worker roles receive no new proposal write grants. Database transition guards disallow agreement/execution states in milestone A; single-OFFERED uniqueness supplements case locking. No acceptance endpoint, financial Approval, refund reservation or execution outbox is created. B must add a reviewed, exact-version both-party agreement and distinct financial authorization without bypassing these controls. Existing Gemini consent and credential separation are unchanged; no external inference is invoked by negotiation.

## Phase 6 completion controls

Exact customer consent, recent merchant authorization, capture-first lock ordering, immutable approval/intent metadata, forced tenant RLS and financial balance checks gate execution. Database state guards reject forged completion; payment workers may read Case.version for atomic increments but not complaint descriptions/private proposal terms. UNKNOWN retains reservations; an observed refund can recover from a persistence rollback without a second POST. Mock processing requires account mode plus synthetic capture provenance and carries no provider credentials. Real execution remains disabled. See PHASE-6-REPORT.md for verification scope and the removed hardcoded debug credential.
