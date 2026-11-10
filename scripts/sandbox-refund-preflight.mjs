import fs from 'node:fs';
import { parse } from 'dotenv';
import { PaymentDatabase } from '../packages/payment-store/dist/index.js';
// Local READ ONLY preview. Never constructs a provider, payment intent, approval or refund.
const v = parse(fs.readFileSync('.env', 'utf8'));
const db = new PaymentDatabase(v.DATABASE_URL);
try {
  const safe = await db.rows('SELECT current_user AS role');
  if (safe[0]?.role !== 'resolve_runtime') throw Error('RUNTIME_ROLE_REQUIRED');
  console.log(
    JSON.stringify({
      mode: 'PREVIEW_ONLY',
      externalRequests: 0,
      proposedNewSandboxPurchase: { amountMinor: '100', currency: 'USD' },
      proposedFullRefund: { amountMinor: '100', currency: 'USD' },
      protectedCaptureExcluded: true,
      requiredApproval:
        'Explicit approval for one NEW USD 1.00 Sandbox purchase/capture and one full refund; buyer approval is manual.',
      steps: [
        'Create a disposable local merchant/customer/order and a separately assigned payment account; do not enable the protected account',
        'Buyer approves new order through the SDK; verify server capture and provider association',
        'Submit synthetic complaint/evidence, exact Google consent, validated REAL analysis and merchant review (Gemini presently blocked)',
        'Publish exact offer, customer accepts, merchant separately authorizes',
        'Enable refund only in the isolated assigned worker for that approved intent; execute once with immutable request ID',
        'Verify refund GET, signed webhook replay, reconciliation, reservations zero, analytics once',
        'Disable isolated worker execution and retain sanitized audit evidence',
      ],
    }),
  );
} finally {
  await db.close();
}
