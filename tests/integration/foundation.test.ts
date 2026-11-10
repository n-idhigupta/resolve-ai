import { assertDisposableReset } from './helpers.js';
assertDisposableReset();
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { env, runtime, migration, password } from './helpers.js';
import {
  seedDevelopment,
  fixtureIds as ids,
} from '../../apps/api/src/dev-fixtures.js';
import {
  assertSafeRuntime,
  withActorTransaction,
  withTenantTransaction,
} from '../../apps/api/src/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth, tokenHash } from '../../apps/api/src/auth.js';
import { registerOrders } from '../../apps/api/src/orders.js';
import { reserveRefund } from '../../apps/api/src/reservations.js';
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy: () => null,
});
redis.on('error', () => {});
const app = await createApp(env, {
  checkDatabase: () => runtime.$queryRaw`SELECT 1`,
  checkRedis: () => redis.ping(),
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerOrders(app, runtime, env);
beforeAll(async () => {
  await runtime.$queryRaw`SELECT 1`;
  await redis.ping();
  await migration.$executeRawUnsafe('TRUNCATE TABLE "Merchant","User" CASCADE');
  await seedDevelopment(migration, {
    nodeEnv: 'test',
    enabled: true,
    password,
  });
});
afterAll(async () => {
  await app.close();
  await Promise.allSettled([
    runtime.$disconnect(),
    migration.$disconnect(),
    redis.quit(),
  ]);
});
let loginIp = 10;
async function login(email = 'customer@resolveai.test') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '127.0.0.' + loginIp++,
    headers: { origin: env.WEB_ORIGIN },
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return {
    cookie: first.split(';')[0]!,
    csrf: response.json().data.csrfToken as string,
    body: response.json(),
    setCookie: first,
  };
}
describe('database and runtime RLS', () => {
  it('connects using runtime role and refuses privileged role', async () => {
    await expect(assertSafeRuntime(runtime)).resolves.toBeUndefined();
    await expect(assertSafeRuntime(migration)).rejects.toThrow(
      'Unsafe runtime',
    );
  });
  it('denies tenant rows without context', async () => {
    expect(await runtime.order.findMany()).toEqual([]);
  });
  it('scopes merchant reads and prevents cross-tenant writes', async () => {
    const rows = await withTenantTransaction(
      runtime,
      { userId: ids.owner },
      ids.merchant,
      (tx) => tx.order.findMany(),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.merchantId === ids.merchant)).toBe(true);
    await expect(
      withTenantTransaction(
        runtime,
        { userId: ids.owner },
        ids.merchant,
        (tx) =>
          tx.auditEvent.create({
            data: {
              merchantId: ids.merchant2,
              aggregateType: 'TEST',
              aggregateId: randomUUID(),
              actorType: 'USER',
              action: 'DENIED',
              visibility: 'INTERNAL',
              correlationId: randomUUID(),
              redactedMetadata: {},
            },
          }),
      ),
    ).rejects.toThrow();
  });
  it('clears transaction context after success and rollback', async () => {
    await withTenantTransaction(
      runtime,
      { userId: ids.owner },
      ids.merchant,
      (tx) => tx.order.findMany(),
    );
    expect(await runtime.order.findMany()).toEqual([]);
    await expect(
      withTenantTransaction(
        runtime,
        { userId: ids.owner },
        ids.merchant,
        async () => {
          throw Error('rollback');
        },
      ),
    ).rejects.toThrow('rollback');
    expect(await runtime.order.findMany()).toEqual([]);
    await withTenantTransaction(
      runtime,
      { userId: ids.owner2 },
      ids.merchant2,
      async (tx) => {
        const rows = await tx.order.findMany();
        expect(rows.every((r) => r.merchantId === ids.merchant2)).toBe(true);
      },
    );
  });
  it('customer RLS hides other same-tenant orders', async () => {
    const rows = await withTenantTransaction(
      runtime,
      { userId: ids.customer },
      ids.merchant,
      (tx) => tx.order.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([ids.order]);
  });
  it('discovers only self memberships before tenant selection', async () => {
    const memberships = await withActorTransaction(runtime, ids.owner, (tx) =>
      tx.membership.findMany(),
    );
    expect(memberships.every((r) => r.userId === ids.owner)).toBe(true);
  });
  it('enforces composite foreign keys even for migration role', async () => {
    await expect(
      migration.orderItem.create({
        data: {
          merchantId: ids.merchant2,
          orderId: ids.order,
          description: 'invalid',
          quantity: 1,
          unitMinor: 1n,
          currency: 'USD',
        },
      }),
    ).rejects.toThrow();
  });
  it('published policy cannot change', async () => {
    await expect(
      migration.policyVersion.update({
        where: { id: ids.policy },
        data: { contentHash: 'tampered' },
      }),
    ).rejects.toThrow();
  });
  it('development seed cannot run in production or without opt-in', async () => {
    await expect(
      seedDevelopment(migration, {
        nodeEnv: 'production',
        enabled: true,
        password,
      }),
    ).rejects.toThrow();
    await expect(
      seedDevelopment(migration, { nodeEnv: 'test', enabled: false, password }),
    ).rejects.toThrow();
  });
});
describe('HTTP authentication and authorization', () => {
  it('checks actual database and Redis readiness', async () => {
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });
  it('rejects unauthenticated and invalid requests', async () => {
    expect((await app.inject('/api/v1/orders')).statusCode).toBe(401);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: env.WEB_ORIGIN },
      payload: { email: 'invalid', password: 'bad' },
    });
    expect(r.statusCode).toBe(422);
  });
  it('rejects invalid credentials and untrusted origins', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: env.WEB_ORIGIN },
          payload: { email: 'missing@resolveai.test', password: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { origin: 'https://evil.example' },
          payload: { email: 'customer@resolveai.test', password },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('sets secure-local cookie attributes and returns session', async () => {
    const auth = await login();
    expect(auth.setCookie).toContain('HttpOnly');
    expect(auth.setCookie).toContain('SameSite=Lax');
    expect(auth.setCookie).not.toContain('Domain=');
    const r = await app.inject({
      url: '/api/v1/auth/session',
      headers: { cookie: auth.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.user.id).toBe(ids.customer);
    expect(auth.body.data.memberships).toEqual([]);
  });
  it('lists only customer-owned orders and denies other ownership', async () => {
    const auth = await login();
    const headers = { cookie: auth.cookie };
    const list = await app.inject({ url: '/api/v1/orders', headers });
    expect(list.json().data.map((r: { id: string }) => r.id)).toEqual([
      ids.order,
    ]);
    expect(
      (await app.inject({ url: '/api/v1/orders/' + ids.order, headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/orders/' + ids.otherOrder, headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/orders/' + ids.foreignOrder, headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/api/v1/orders?limit=101', headers }))
        .statusCode,
    ).toBe(422);
  });
  it('merchant agent can read its tenant but not another', async () => {
    const auth = await login('support@resolveai.test'),
      headers = { cookie: auth.cookie };
    expect(
      (
        await app.inject({
          url: `/api/v1/merchants/${ids.merchant}/orders`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/v1/merchants/${ids.merchant2}/orders`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('rejects missing/wrong CSRF then logs out and revokes', async () => {
    const auth = await login();
    for (const token of [undefined, '0'.repeat(64)]) {
      const headers: Record<string, string> = {
        cookie: auth.cookie,
        origin: env.WEB_ORIGIN,
      };
      if (token) headers['x-csrf-token'] = token;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/logout',
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/logout',
          headers: {
            cookie: auth.cookie,
            origin: env.WEB_ORIGIN,
            'x-csrf-token': auth.csrf,
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('expires idle/absolute sessions and rejects disabled users', async () => {
    for (const mode of ['idle', 'absolute', 'disabled']) {
      const auth = await login('other-customer@resolveai.test');
      const hashed = tokenHash(auth.cookie.split('=')[1]!, env);
      if (mode === 'idle')
        await migration.session.update({
          where: { tokenHash: hashed },
          data: { lastSeenAt: new Date(Date.now() - 1800001) },
        });
      if (mode === 'absolute')
        await migration.session.update({
          where: { tokenHash: hashed },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
      if (mode === 'disabled')
        await migration.user.update({
          where: { id: ids.otherCustomer },
          data: { status: 'DISABLED' },
        });
      try {
        expect(
          (
            await app.inject({
              url: '/api/v1/auth/session',
              headers: { cookie: auth.cookie },
            })
          ).statusCode,
        ).toBe(401);
      } finally {
        await migration.user.update({
          where: { id: ids.otherCustomer },
          data: { status: 'ACTIVE' },
        });
      }
    }
  });
});
async function financialFixture(amount = 3000n) {
  const merchantId = ids.merchant,
    orderId = randomUUID(),
    accountId = randomUUID(),
    caseId = randomUUID(),
    captureId = randomUUID(),
    proposalId = randomUUID();
  await migration.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id: orderId,
        merchantId,
        customerUserId: ids.customer,
        purchasePolicyVersionId: ids.policy,
        merchantReference: orderId,
        amountMinor: 10000n,
        currency: 'USD',
        status: 'PAID',
      },
    });
    await tx.customerOrder.create({
      data: { merchantId, orderId, userId: ids.customer },
    });
    await tx.paymentAccount.create({
      data: {
        id: accountId,
        merchantId,
        environment: 'sandbox',
        providerMerchantId: accountId,
        credentialSecretRef: 'test-only-no-credentials',
        accountKey: accountId,
      },
    });
    await tx.capture.create({
      data: {
        id: captureId,
        merchantId,
        orderId,
        accountId,
        providerCaptureId: captureId,
        providerOrderId: orderId,
        grossMinor: 10000n,
        currency: 'USD',
        providerStatus: 'COMPLETED',
        completedAt: new Date(),
      },
    });
    await tx.case.create({
      data: {
        id: caseId,
        merchantId,
        orderId,
        openedBy: ids.customer,
        policyVersionId: ids.policy,
        reason: 'DAMAGED',
        description: 'Synthetic test only',
        status: 'NEGOTIATING',
      },
    });
    await tx.proposal.create({
      data: {
        id: proposalId,
        merchantId,
        caseId,
        orderId,
        policyVersionId: ids.policy,
        sequence: 1,
        kind: 'PARTIAL_REFUND',
        amountMinor: amount,
        currency: 'USD',
        termsJson: { customerMessage: 'Synthetic fixture' },
        contentHash: proposalId,
        expiresAt: new Date(Date.now() + 3600000),
        status: 'AGREED',
      },
    });
    await tx.case.update({
      where: { id: caseId },
      data: { currentProposalId: proposalId },
    });
    for (const [actorUserId, actorRole] of [
      [ids.customer, 'CUSTOMER'],
      [ids.owner, 'MERCHANT'],
    ] as const)
      await tx.approval.create({
        data: {
          merchantId,
          proposalId,
          actorUserId,
          actorRole,
          decision: 'ACCEPT',
          contentHash: proposalId,
          policyVersionId: ids.policy,
          decidedAt: new Date(),
          authenticationContext: { test: true },
        },
      });
  });
  return { merchantId, captureId, caseId, proposalId };
}
describe('internal financial reservations only', () => {
  it('serializes concurrent duplicate reservations to one operation', async () => {
    const input = await financialFixture();
    const actor = { userId: ids.owner, authenticatedAt: new Date() };
    const operations = await Promise.all(
      Array.from({ length: 6 }, () => reserveRefund(runtime, actor, input)),
    );
    expect(new Set(operations.map((x) => x.id)).size).toBe(1);
    expect(
      (
        await migration.capture.findUniqueOrThrow({
          where: { id: input.captureId },
        })
      ).reservedMinor,
    ).toBe(3000n);
    expect(
      await migration.refundOperation.count({
        where: { proposalId: input.proposalId },
      }),
    ).toBe(1);
    expect(
      await migration.auditEvent.count({
        where: { aggregateId: operations[0]!.id },
      }),
    ).toBe(1);
  });
  it('denies support agent, insufficient funds and expired consent without partial writes', async () => {
    const input = await financialFixture(11000n);
    await expect(
      reserveRefund(
        runtime,
        { userId: ids.agent, authenticatedAt: new Date() },
        input,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reserveRefund(
        runtime,
        { userId: ids.owner, authenticatedAt: new Date() },
        input,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(
      (
        await migration.capture.findUniqueOrThrow({
          where: { id: input.captureId },
        })
      ).reservedMinor,
    ).toBe(0n);
    expect(
      await migration.refundOperation.count({
        where: { proposalId: input.proposalId },
      }),
    ).toBe(0);
    await expect(
      reserveRefund(
        runtime,
        { userId: ids.owner, authenticatedAt: new Date(0) },
        input,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('retains reservation when operation becomes UNKNOWN', async () => {
    const input = await financialFixture();
    const op = await reserveRefund(
      runtime,
      { userId: ids.owner, authenticatedAt: new Date() },
      input,
    );
    await migration.refundOperation.update({
      where: { id: op.id },
      data: { state: 'UNKNOWN' },
    });
    const again = await reserveRefund(
      runtime,
      { userId: ids.owner, authenticatedAt: new Date() },
      input,
    );
    expect(again.id).toBe(op.id);
    expect(again.state).toBe('UNKNOWN');
    expect(
      (
        await migration.capture.findUniqueOrThrow({
          where: { id: input.captureId },
        })
      ).reservedMinor,
    ).toBe(3000n);
  });
});

it('rolls back the entire reservation when audit insertion fails', async () => {
  const input = await financialFixture();
  await migration.$executeRawUnsafe(
    'REVOKE INSERT ON "AuditEvent" FROM resolve_test',
  );
  try {
    await expect(
      reserveRefund(
        runtime,
        { userId: ids.owner, authenticatedAt: new Date() },
        input,
      ),
    ).rejects.toThrow();
    expect(
      await migration.refundOperation.count({
        where: { proposalId: input.proposalId },
      }),
    ).toBe(0);
    expect(
      (
        await migration.capture.findUniqueOrThrow({
          where: { id: input.captureId },
        })
      ).reservedMinor,
    ).toBe(0n);
  } finally {
    await migration.$executeRawUnsafe(
      'GRANT INSERT ON "AuditEvent" TO resolve_test',
    );
  }
});
it('runtime cannot assume migration role', async () => {
  await expect(
    runtime.$executeRawUnsafe('SET ROLE resolve_migrator'),
  ).rejects.toThrow();
});
it('login rotates and revokes the previous session', async () => {
  const first = await login();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '127.0.0.250',
    headers: { origin: env.WEB_ORIGIN, cookie: first.cookie },
    payload: { email: 'customer@resolveai.test', password },
  });
  expect(response.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        url: '/api/v1/auth/session',
        headers: { cookie: first.cookie },
      })
    ).statusCode,
  ).toBe(401);
});
it('production session cookies are Secure', async () => {
  const prod = {
    ...env,
    NODE_ENV: 'production' as const,
    ENABLE_DEV_SEED: 'false' as const,
    WEB_ORIGIN: 'https://merchant.example',
  };
  const server = await createApp(prod, {
    checkDatabase: async () => 1,
    checkRedis: async () => 1,
    close: async () => {},
  });
  await registerAuth(server, runtime, prod);
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: prod.WEB_ORIGIN },
      payload: { email: 'customer@resolveai.test', password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('Secure');
  } finally {
    await server.close();
  }
});

it('prevents moving a published clause into an unpublished policy', async () => {
  const merchantId = ids.merchant,
    publishedId = randomUUID(),
    draftId = randomUUID(),
    clauseId = randomUUID();
  await migration.policyVersion.create({
    data: {
      id: publishedId,
      merchantId,
      sequence: 100,
      contentHash: publishedId,
      effectiveFrom: new Date(),
    },
  });
  await migration.policyClause.create({
    data: {
      id: clauseId,
      merchantId,
      policyVersionId: publishedId,
      clauseKey: 'test',
      text: 'Published fixture',
      rulesJson: {},
    },
  });
  await migration.policyVersion.update({
    where: { id: publishedId },
    data: { publishedAt: new Date() },
  });
  await migration.policyVersion.create({
    data: {
      id: draftId,
      merchantId,
      sequence: 101,
      contentHash: draftId,
      effectiveFrom: new Date(),
    },
  });
  await expect(
    migration.policyClause.update({
      where: { id: clauseId },
      data: { policyVersionId: draftId },
    }),
  ).rejects.toThrow();
});
