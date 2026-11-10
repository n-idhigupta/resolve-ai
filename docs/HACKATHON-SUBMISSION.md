# Hackathon submission - sponsor technology

ResolveAI uses **AG Grid Community + AG Grid React (36.3.0)** in its merchant complaint inbox. Sortable and resizable columns, floating text filters, pagination, custom React status badges and AI review/risk indicators help merchants triage complaints. Only free Community modules are registered; no Enterprise license or paid grid features are used.

The grid reuses the tenant-authorized case API and existing detail route. Row click, a keyboard-accessible complaint link or Enter on a focused cell opens the case. Missing analysis is labelled No analysis; stale, revoked and review-required results are flagged without inventing a risk score or financial authority. The merchant-only list summary contains status/staleness/revocation metadata, never decrypted AI output.

Demo: open Merchant Cases, sort Complaint, filter a title/status, change page size and open a row. Grid operations apply to the loaded 25-case server batch. Existing search/status/category/date controls and cursor navigation query the full authorized inbox. Grid pagination offers 10 or 25 rows per page. The responsive grid remains visible on mobile with internal horizontal scrolling; loading, empty, filtered-empty and retryable error states are explicit.

This is a focused sponsor integration, not a replacement for the core PayPal/AI workflows. No real provider request, payment operation, deployment, license purchase or external hackathon submission was performed. Real-integration limitations remain documented in INTEGRATION-READINESS.md.

## Verification

15 focused case/tenant integration tests and all 5 negotiation/grid browser tests passed against the approved disposable verification database. Browser coverage includes sorting, filtering, filtered-empty state, pagination controls, row navigation, mobile width, error/retry, stale analysis metadata and cross-tenant denial, alongside existing mocked settlement workflows. Formatting, lint, strict typecheck and all nine package builds passed. The existing frontend bundle-size warning remains nonfatal. Early browser harness failures (Strict Mode duplicate loads and ambiguous header locator) were corrected; the filtered-empty overlay was fixed without weakening tests. No real PayPal/Gemini calls or existing-database reset occurred.

## Submission-ready product summary

ResolveAI helps merchants resolve internal payment complaints before formal disputes: verified PayPal payment context, private scanned evidence, explicit AI sharing consent, cited nonbinding intelligence, human negotiation and separate financial authorization. FORCE RLS, stable operation keys, reservations, signed webhooks and reconciliation protect the flow. AG Grid Community powers merchant triage.

Actual provider evidence: the separately authorized USD1 Sandbox order8SE437503D359100F, capture6Y521778HF557060P and full refund30M07053WJ648601P completed and reconciled with actual signed webhook delivery/replay. The protected USD100 capture is unchanged. Demo AI is clearly mocked; real Gemini metadata/token counting succeeded but generation returned503 and real recommendation quality is unverified. Deployment configuration is prepared, not deployed. No production payment or billing activation. See DEMO.md for the four-minute script and SANDBOX-DOLLAR-TEST.md for financial proof. Submitters must supply their actual repository, video and any approved hosted URL; no submission has been sent automatically.

## Final delivery status

Final recheck:11 browser tests and6 production-configuration unit tests passed, and the actual local demo launcher started API/web/restricted mock workers and shut down successfully. No Gemini request was made. Use the completed real Sandbox transaction as recorded provider proof alongside the visibly mocked AI demonstration. Public deployment is pending owner approval and hosting/staging prerequisites; do not describe the production Blueprint as live Sandbox checkout. See DELIVERY-CHECKLIST.md and RENDER.md.
