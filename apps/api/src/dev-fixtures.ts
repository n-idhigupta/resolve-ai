import { hashPassword } from './auth.js';
import type { Database } from './database.js';
export const fixtureIds = {
  merchant: '10000000-0000-4000-8000-000000000001',
  merchant2: '10000000-0000-4000-8000-000000000002',
  owner: '20000000-0000-4000-8000-000000000001',
  agent: '20000000-0000-4000-8000-000000000002',
  customer: '20000000-0000-4000-8000-000000000003',
  otherCustomer: '20000000-0000-4000-8000-000000000004',
  owner2: '20000000-0000-4000-8000-000000000005',
  order: '30000000-0000-4000-8000-000000000001',
  otherOrder: '30000000-0000-4000-8000-000000000002',
  foreignOrder: '30000000-0000-4000-8000-000000000003',
  policy: '40000000-0000-4000-8000-000000000001',
  policy2: '40000000-0000-4000-8000-000000000002',
};
export async function seedDevelopment(
  db: Database,
  options: { nodeEnv: string; enabled: boolean; password: string },
) {
  if (
    options.nodeEnv === 'production' ||
    !options.enabled ||
    options.password.length < 20
  )
    throw Error(
      'Development seed requires explicit opt-in and a strong local password',
    );
  const ids = fixtureIds,
    passwordHash = await hashPassword(options.password);
  await db.$transaction(async (tx) => {
    for (const [id, name] of [
      [ids.merchant, 'Demo Merchant'],
      [ids.merchant2, 'Isolation Merchant'],
    ] as const)
      await tx.merchant.upsert({
        where: { id },
        create: { id, name, defaultCurrency: 'USD' },
        update: {},
      });
    for (const [id, email] of [
      [ids.owner, 'admin@resolveai.test'],
      [ids.agent, 'support@resolveai.test'],
      [ids.customer, 'customer@resolveai.test'],
      [ids.otherCustomer, 'other-customer@resolveai.test'],
      [ids.owner2, 'other-admin@resolveai.test'],
    ] as const)
      await tx.user.upsert({
        where: { id },
        create: { id, normalizedEmail: email, passwordHash },
        update: { passwordHash },
      });
    for (const [merchantId, userId, role] of [
      [ids.merchant, ids.owner, 'OWNER'],
      [ids.merchant, ids.agent, 'AGENT'],
      [ids.merchant2, ids.owner2, 'OWNER'],
    ] as const)
      await tx.membership.upsert({
        where: { merchantId_userId: { merchantId, userId } },
        create: { merchantId, userId, role },
        update: { active: true },
      });
    for (const [id, merchantId] of [
      [ids.policy, ids.merchant],
      [ids.policy2, ids.merchant2],
    ] as const)
      await tx.policyVersion.upsert({
        where: { id },
        create: {
          id,
          merchantId,
          sequence: 1,
          contentHash: 'development-policy-v1',
          effectiveFrom: new Date('2026-01-01'),
          publishedAt: new Date('2026-01-01'),
        },
        update: {},
      });
    for (const [id, merchantId, customerUserId, policyId] of [
      [ids.order, ids.merchant, ids.customer, ids.policy],
      [ids.otherOrder, ids.merchant, ids.otherCustomer, ids.policy],
      [ids.foreignOrder, ids.merchant2, ids.owner2, ids.policy2],
    ] as const) {
      await tx.order.upsert({
        where: { id },
        create: {
          id,
          merchantId,
          customerUserId,
          purchasePolicyVersionId: policyId,
          merchantReference: id,
          amountMinor: 10000n,
          currency: 'USD',
        },
        update: {},
      });
      const itemId = id.replace('30000000', '31000000');
      await tx.orderItem.upsert({
        where: { id: itemId },
        create: {
          id: itemId,
          merchantId,
          orderId: id,
          description: 'Synthetic demonstration order',
          quantity: 1,
          unitMinor: 10000n,
          currency: 'USD',
        },
        update: {},
      });
      await tx.customerOrder.upsert({
        where: {
          merchantId_orderId_userId: {
            merchantId,
            orderId: id,
            userId: customerUserId,
          },
        },
        create: { merchantId, orderId: id, userId: customerUserId },
        update: {},
      });
    }
  });
}
