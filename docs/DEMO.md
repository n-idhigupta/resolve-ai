# Hackathon demo (3�5 minutes)

This demo uses a synthetic pre-recorded purchase, deterministic local mock AI and a queued mock refund. No real payment is created or refunded. Internal complaints are not PayPal disputes. The previously verified USD 100 Sandbox capture is preserved and is not the demo refund target.

## Start locally

Use the existing local `.env` credentials; never paste them into recordings. PostgreSQL, Redis and storage must already be healthy (`pnpm infra:up` for the configured Compose services). Apply additive migrations and generate a new isolated synthetic tenant:

```powershell
pnpm db:migrate
pnpm demo:hackathon
pnpm demo:start
```

The seed requires `ENABLE_DEV_SEED=true`, a development database, `DEV_SEED_PASSWORD` and the existing restricted worker roles/artifact key. It appends fixtures; it does not reset anything. Record the printed fake customer/merchant emails, merchant workspace URL and purchaseOrderId. Both logins use your local `DEV_SEED_PASSWORD` (never printed). Re-running creates another independent demo tenant. Stop any existing API/web instances before `demo:start`; use Ctrl+C to stop this stack.

Web: http://localhost:5173. API: http://localhost:3001. The launcher disables checkout, external inference and real refunds, and launches restricted local prepare/infer and mock-refund workers. Inference has neither provider nor original-storage credentials. No browser key is needed. Local mock consent is distinct from OpenAI/Google sharing consent.

## Present

1. **0:00�0:40 � Trustworthy purchase context.** Sign in as the printed synthetic customer. Open My Orders, select the printed purchaseOrderId and explain the verified synthetic payment badge. This is a pre-recorded local fixture, not a live checkout.
2. **0:40�1:25 � Complaint.** Open a damaged-item complaint, give a short synthetic description and request a partial refund. Explain ownership checks, immutable policy snapshot and internal-complaint label. Evidence remains unavailable until actual validation/scanning; the quick demo requires no upload.
3. **1:25�2:05 � Consent and intelligence.** In the customer case, prepare the sharing preview, inspect exact sources and the local-only disclosure, then consent. In a separate browser profile sign in as the printed merchant, open the new case and request AI analysis. Show the scripted mock label, citations, uncertainty and server-calculated remedy bounds. Enter a review reason and approve the internal recommendation; this sends no offer and moves no funds.
4. **2:05�3:20 � Negotiation and separate authorization.** Use the reviewed suggestion, enter clear customer-visible terms and save/publish the offer. Optionally counteroffer from the customer and publish revised terms. The customer reviews the exact version/amount and explicitly accepts. The merchant separately confirms authorization. Show pending status followed by **Mock refund verified � no PayPal funds moved**. Refresh to demonstrate durable history.
5. **3:20�4:10 � Outcomes.** Open merchant Analytics. Show complaint distribution, resolution time, separate AI review/financial authorization metrics and mock-labelled refund totals. Explain tenant scoping, reservations, stable idempotency and UNKNOWN reconciliation. Conclude with the separately verified USD1 Sandbox capture/full refund and signed-webhook replay evidence. Gemini generation remains unverified after HTTP503; the on-screen AI is explicitly mocked.

## Verify

`pnpm check:safe` runs all unit tests and append-only integration/browser coverage. Legacy reset-based tests are excluded deliberately. Never use `pnpm check` under a no-reset boundary. Real-provider smoke commands are separate opt-ins and are not part of this demo.

## Real Sandbox proof segment

Open SANDBOX-DOLLAR-TEST.md after the scripted journey: show the three public provider IDs, completed refund/reconciled ledger, signed delivery/replay and disabled execution. Do not click Pay or authorize another refund during the presentation. The recorded real transaction is already fully refunded. This proof is separate from the synthetic mock-AI demo; a complete real-Gemini-to-refund journey has not passed.
