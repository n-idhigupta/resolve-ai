import { randomUUID } from 'node:crypto';
import type { Database } from '../apps/api/src/database.js';
import { hashPassword } from '../apps/api/src/auth.js';
export async function createSettlementFixture(
  db: Database,
  password: string,
  workerRole = 'resolve_payments_test',
) {
  const merchantId = randomUUID(),
    owner = randomUUID(),
    customer = randomUUID(),
    agent = randomUUID(),
    policyId = randomUUID(),
    orderId = randomUUID(),
    suffix = merchantId.slice(0, 8);
  const hash = await hashPassword(password);
  const result = await db.$transaction(async (tx) => {
    await tx.merchant.create({
      data: { id: merchantId, name: 'Synthetic settlement demo ' + suffix },
    });
    for (const [id, email] of [
      [owner, `settlement-merchant-${suffix}@resolveai.test`],
      [customer, `settlement-customer-${suffix}@resolveai.test`],
      [agent, `settlement-agent-${suffix}@resolveai.test`],
    ])
      await tx.user.create({
        data: { id: id!, normalizedEmail: email!, passwordHash: hash },
      });
    await tx.membership.createMany({
      data: [
        { merchantId, userId: owner, role: 'OWNER' },
        { merchantId, userId: agent, role: 'AGENT' },
      ],
    });
    await tx.policyVersion.create({
      data: {
        id: policyId,
        merchantId,
        sequence: 1,
        contentHash: randomUUID(),
        effectiveFrom: new Date(),
      },
    });
    const rules = {
      schemaVersion: 1,
      applicableReasons: ['DAMAGED'],
      allowedRemedies: ['FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT', 'HELP'],
      complaintWindowDays: 30,
      requiredEvidenceTypes: [],
      maxPartialRefundBps: 7500,
      maxRefundMinor: '10000',
      manualReviewThresholdMinor: null,
      mandatoryHumanReview: true,
      replacementAllowed: true,
    };
    await tx.policyClause.create({
      data: {
        merchantId,
        policyVersionId: policyId,
        clauseKey: 'synthetic-returns',
        text: 'Synthetic demo: merchant-reviewed remedies only, no real payment.',
        rulesJson: rules,
      },
    });
    await tx.policyVersion.update({
      where: { id: policyId },
      data: { publishedAt: new Date() },
    });
    await tx.merchant.update({
      where: { id: merchantId },
      data: { activePolicyVersionId: policyId },
    });
    await tx.order.create({
      data: {
        id: orderId,
        merchantId,
        customerUserId: customer,
        purchasePolicyVersionId: policyId,
        merchantReference: 'SYNTHETIC-' + suffix,
        amountMinor: 10000n,
        currency: 'USD',
        status: 'PAID',
        paymentState: 'CAPTURED',
      },
    });
    await tx.customerOrder.create({
      data: { merchantId, orderId, userId: customer },
    });
    const account = await tx.paymentAccount.create({
      data: {
        merchantId,
        environment: 'sandbox',
        providerMerchantId: 'SYNTHETIC_SELLER_' + suffix,
        credentialSecretRef: 'synthetic-no-credential',
        accountKey: 'synthetic-' + merchantId,
        enabled: true,
        workerRoleName: workerRole,
        refundMode: 'mock',
        webhookId: 'SYNTHETICWEBHOOK',
      },
    });
    const capture = await tx.capture.create({
      data: {
        merchantId,
        orderId,
        accountId: account.id,
        providerCaptureId: 'SYNTHETIC_CAPTURE_' + suffix,
        providerOrderId: 'SYNTHETIC_ORDER_' + suffix,
        grossMinor: 10000n,
        currency: 'USD',
        providerStatus: 'COMPLETED',
        completedAt: new Date(),
        verifiedAt: new Date(),
      },
    });
    const c = await tx.case.create({
      data: {
        merchantId,
        orderId,
        openedBy: customer,
        policyVersionId: policyId,
        reason: 'DAMAGED',
        title: 'Synthetic damaged demonstration item',
        description:
          'Explicitly synthetic complaint for negotiation and mock settlement. No real customer or payment.',
        requestedOutcome: 'PARTIAL_REFUND',
        policySnapshot: {
          eligible: true,
          legacy: false,
          allowedRemedies: rules.allowedRemedies,
          maxPartialRefundBps: 7500,
          potentialRefundCapMinor: '10000',
          requiredEvidenceTypes: [],
          reviewReasons: ['MANUAL_REVIEW_REQUIRED'],
        },
      },
    });
    return { accountId: account.id, captureId: capture.id, caseId: c.id };
  });
  return {
    ...result,
    merchantId,
    owner,
    customer,
    agent,
    policyId,
    orderId,
    ownerEmail: `settlement-merchant-${suffix}@resolveai.test`,
    customerEmail: `settlement-customer-${suffix}@resolveai.test`,
  };
}
