# Final hackathon delivery checklist

## Ready

- [x] Real USD1 Sandbox purchase/capture/full refund verified, signed webhook processing/replay and local reconciliation/analytics verified. Protected USD100 capture unchanged; execution disabled again.
- [x] AG Grid Community integration, merchant tenant authorization and polished case workflow retained.
- [x] Mock AI and mock financial demo labels are explicit. Two real Gemini attempts returned503; no real recommendation quality is claimed. No retry/model switch/billing activation is authorized.
- [x] Render Blueprint, pinned Docker build, HTTPS upstream template and environment checklist prepared; no resources created/deployed.
- [x] Four-minute script and sponsor/submission content prepared. See DEMO.md and HACKATHON-SUBMISSION.md.

## Exact local presentation actions

1. Keep Gemini and real refund execution disabled. Start existing local infrastructure/scanner using `pnpm infra:up` and `pnpm scanner:up` if needed; do not recreate credentials or reset data.
2. Stop any existing local API/web on3001/5173. Run `pnpm demo:hackathon` once to append a fresh synthetic demo tenant, then `pnpm demo:start`. Use the printed customer/merchant URLs and your existing local DEV_SEED_PASSWORD; never show it in the recording. Do not seed production.
3. Follow DEMO.md: orders, complaint, exact local consent, mock recommendation/review, AG Grid triage, negotiation, separate customer acceptance/merchant authorization, explicitly MOCK refund and analytics. The launcher intentionally disables actual PayPal calls.
4. Show SANDBOX-DOLLAR-TEST.md or the existing captured transaction's read-only history as separate evidence of genuine PayPal integration. The USD1 order is already refunded; do not click Pay again or authorize another refund. Never present a synthetic purchase as the real transaction.
5. Record a3-5-minute video without `.env`, tokens, private evidence, password managers or network authorization headers. Use HACKATHON-SUBMISSION.md copy and identify AG Grid Community as sponsor technology.

## Owner actions still required

- Approve a repository/branch and supply the submission repository/video URLs; publishing/submission has not been performed.
- Approve any public deployment and select approved PostgreSQL/Redis/storage/scanner/worker hosting. The current production Blueprint deliberately blocks Sandbox execution and omits workers/scanning; live public Sandbox requires a separately reviewed staging setup. The supported immediate presentation is the verified-recording plus local mock-AI demo.
- Submit the hackathon form manually (or explicitly authorize submission). Do not claim real Gemini inference or a fully real-provider journey.

The integration acceptance gap is Gemini provider503, not missing authorization to retry: retries are expressly forbidden. No further Gemini action is required for this submission.

## Final checks executed - 2026-11-10

11 browser tests passed: shell/readiness/error recovery, mocked checkout outcomes, customer/merchant negotiation and settlement, synthetic consent/mock AI review, AG Grid sorting/filtering/navigation/mobile/retry and cross-tenant denial. Six configuration unit tests passed, including production Sandbox/refund rejection. The actual demo-start launcher started API/web and restricted mock workers successfully, then was stopped; no services were left on3001/5173. No external AI/payment call, destructive reset or deployment was performed. Existing successful package/image builds were retained instead of rebuilding unchanged code.
