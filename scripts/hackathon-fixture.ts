import { randomUUID } from 'node:crypto';
import type { Database } from '../apps/api/src/database.js';
import { createSettlementFixture } from './settlement-fixture.js';
import {
  IntelligenceService,
  OPENAI_MODEL,
} from '../packages/ai-core/dist/index.js';
import { PaymentDatabase } from '../packages/payment-store/dist/index.js';
export async function createHackathonFixture(
  db: Database,
  runtimeUrl: string,
  key: string,
  password: string,
  test = false,
) {
  const f = await createSettlementFixture(
      db,
      password,
      test ? 'resolve_payments_test' : 'resolve_payments',
    ),
    purchaseOrderId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.demoTenant.create({ data: { merchantId: f.merchantId } });
    await tx.aIWorkerTenant.create({
      data: {
        merchantId: f.merchantId,
        roleName: test ? 'resolve_ai_test' : 'resolve_ai',
      },
    });
    await tx.evidenceWorkerTenant.create({
      data: {
        merchantId: f.merchantId,
        roleName: test ? 'resolve_evidence_test' : 'resolve_evidence',
      },
    });
    await tx.order.create({
      data: {
        id: purchaseOrderId,
        merchantId: f.merchantId,
        customerUserId: f.customer,
        purchasePolicyVersionId: f.policyId,
        merchantReference: 'SYNTHETIC_PURCHASE_' + purchaseOrderId,
        amountMinor: 10000n,
        currency: 'USD',
        status: 'PAID',
        paymentState: 'CAPTURED',
      },
    });
    await tx.orderItem.create({
      data: {
        merchantId: f.merchantId,
        orderId: purchaseOrderId,
        description: 'Synthetic demonstration purchase',
        quantity: 1,
        unitMinor: 10000n,
        currency: 'USD',
      },
    });
    await tx.customerOrder.create({
      data: {
        merchantId: f.merchantId,
        orderId: purchaseOrderId,
        userId: f.customer,
      },
    });
    await tx.capture.create({
      data: {
        merchantId: f.merchantId,
        orderId: purchaseOrderId,
        accountId: f.accountId,
        providerCaptureId:
          'SYNTHETIC_PURCHASE_' + purchaseOrderId.replaceAll('-', ''),
        providerOrderId:
          'SYNTHETIC_ORDER_' + purchaseOrderId.replaceAll('-', ''),
        grossMinor: 10000n,
        currency: 'USD',
        providerStatus: 'COMPLETED',
        completedAt: new Date(),
        verifiedAt: new Date(),
      },
    });
  });
  const runtime = new PaymentDatabase(runtimeUrl);
  try {
    const service = new IntelligenceService(runtime, key);
    await service.sharingPolicy(
      { merchantId: f.merchantId, userId: f.owner },
      { enabled: true, modelId: OPENAI_MODEL, dailyBudgetMicros: 1000000 },
    );
  } finally {
    await runtime.close();
  }
  return { ...f, purchaseOrderId };
}
