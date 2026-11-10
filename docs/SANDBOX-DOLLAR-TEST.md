# Controlled USD1 Sandbox test - completed

2026-11-10. The user authorized exactly one disposable USD1 purchase/capture and one full USD1 refund. That authorization has now been consumed. Do not rerun financial dispatch helpers or create another transaction without fresh approval.

| Provider resource | ID                | Final provider status |
| ----------------- | ----------------- | --------------------- |
| Order             | 8SE437503D359100F | COMPLETED             |
| Capture           | 6Y521778HF557060P | REFUNDED              |
| Refund            | 30M07053WJ648601P | COMPLETED             |

The test used the separate `resolveai_sandbox_dollar_20261110` database, new synthetic merchant/customer/account and a dedicated Cloudflare Tunnel webhook. All 30 existing migrations were applied; no original account binding or database was reset. The new subscription includes PAYMENT.CAPTURE.REFUNDED alongside approval/capture events. The original subscription was preserved.

OAuth/app webhook ownership, Sandbox-only endpoints, configured merchant/payee, server-calculated USD1 amount, resource associations and refund permission were checked. The user approved the existing order in the official SDK popup; authoritative Orders GET confirmed APPROVED before the single capture. The existing application verified and persisted that capture.

The authenticated complaint/evidence/negotiation routes created a synthetic case, uploaded text through private storage and verified actual ClamAV CLEAN/scannedAt. The merchant published a USD1 full-refund offer; the customer accepted its exact version/hash; the merchant separately authorized it. Existing policy/balance checks reserved 100 minor units atomically. The actual RefundEngine issued one refund using its stable provider request ID. No uncertain response or financial retry occurred.

Four actual signed PayPal deliveries were verified and processed through the durable inbox. Event types included CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED and PAYMENT.CAPTURE.REFUNDED. Replaying the original signed refund receipt returned 202 and left inbox/receipt/refund counts and ledger version unchanged. No fabricated or unsigned event was used.

Final local ledger: gross=100, refunded=100, reserved=0, externalRefunded=0, currency=USD, reconciliation=CURRENT, version=2. Settlement=COMPLETED, case=RESOLVED, one RefundOperation=COMPLETED. Analytics reports one provider refund totaling 100 minor units and zero mock refund amount.

The isolated account's refundMode was returned to disabled. Normal background inference and global real-refund flags remain disabled. The protected original USD100 capture 7ND54081CF0194732 remains COMPLETED/version0 with zero refunded/reserved/external counters. No other financial transaction was changed.

Sanitized evidence: ignored `.local/dollar/state.json`, durable one-dispatch markers and webhook results. Secret-bearing environment artifacts must never be printed, committed or attached. Quick Tunnel reachability lasts only while its process runs; it is not permanent deployment configuration.

This verifies real purchase/capture, complaint, scanned evidence, negotiation, explicit acceptance/authorization, full refund, signed delivery, replay safety, reconciliation and analytics. It does not verify real AI in that journey, partial real refunds, live payments, multi-seller onboarding or crash injection during this real transaction; those safety paths remain deterministically tested with mocks.
