import { testDatabaseName } from './helpers.js';
import { it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from './helpers.js';
import { createSettlementFixture } from '../../scripts/settlement-fixture.js';
import {
  PaymentDatabase,
  RefundEngine,
  mockRefundProvider,
  PaymentStore,
  PaymentEngine,
  PaymentDelivery,
} from '../../packages/payment-store/dist/index.js';
import {
  CaseStore,
  NegotiationStore,
  SettlementStore,
} from '../../packages/case-store/dist/index.js';
import {
  PayPalError,
  type RefundProvider,
} from '../../packages/paypal-client/dist/index.js';
const db = new PaymentDatabase(env.DATABASE_URL),
  workerUrl = process.env.WORKER_DATABASE_URL!;
if (
  new URL(workerUrl).pathname !== '/' + testDatabaseName ||
  new URL(workerUrl).username !== 'resolve_payments_test'
)
  throw Error('Isolated worker role required');
const workerDb = new PaymentDatabase(workerUrl),
  cases = new CaseStore(db),
  negotiation = new NegotiationStore(cases),
  settlements = new SettlementStore(cases);
const version = async (id: string) =>
  (await migration.case.findUniqueOrThrow({ where: { id } })).version;
async function fixture() {
  const f = await createSettlementFixture(migration, password);
  return {
    ...f,
    customerActor: { merchantId: f.merchantId, userId: f.customer },
    ownerActor: { merchantId: f.merchantId, userId: f.owner },
  };
}
async function offer(f: Awaited<ReturnType<typeof fixture>>) {
  const p = (await negotiation.create(
    f.ownerActor,
    f.caseId,
    {
      kind: 'PARTIAL_REFUND',
      amountMinor: '2500',
      currency: 'USD',
      message: 'Synthetic partial refund for this demonstration only.',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    await version(f.caseId),
    randomUUID(),
  )) as { id: string; contentHash: string; rowVersion: number };
  return (await negotiation.action(
    f.ownerActor,
    f.caseId,
    p.id,
    {
      action: 'PUBLISH',
      contentHash: p.contentHash,
      reason: 'Explicit synthetic merchant review',
    },
    await version(f.caseId),
    randomUUID(),
  )) as typeof p;
}
async function accept(
  f: Awaited<ReturnType<typeof fixture>>,
  p: Awaited<ReturnType<typeof offer>>,
) {
  return (await settlements.accept(
    f.customerActor,
    f.caseId,
    p.id,
    {
      contentHash: p.contentHash,
      proposalVersion: p.rowVersion,
      confirm: true,
    },
    await version(f.caseId),
    randomUUID(),
    new Date(),
  )) as { id: string };
}
async function authorize(
  f: Awaited<ReturnType<typeof fixture>>,
  p: Awaited<ReturnType<typeof offer>>,
  s: { id: string },
) {
  return (await settlements.authorize(
    f.ownerActor,
    f.caseId,
    s.id,
    {
      contentHash: p.contentHash,
      proposalVersion: p.rowVersion + 1,
      confirm: true,
    },
    await version(f.caseId),
    randomUUID(),
    new Date(),
  )) as { refundOperationId: string };
}
afterAll(async () => {
  await Promise.allSettled([
    db.close(),
    workerDb.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
it('records exact acceptance and merchant authorization atomically and completes one mocked partial refund', async () => {
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .reservedMinor,
  ).toBe(2500n);
  const engine = new RefundEngine(workerDb, (a) =>
    mockRefundProvider(workerDb, a),
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      engine.run(f.merchantId, r.refundOperationId),
    ),
  );
  const cap = await migration.capture.findUniqueOrThrow({
    where: { id: f.captureId },
  });
  expect(cap.refundedMinor).toBe(2500n);
  expect(cap.reservedMinor).toBe(0n);
  expect(
    (await migration.settlement.findUniqueOrThrow({ where: { id: s.id } }))
      .state,
  ).toBe('COMPLETED');
  expect(
    (await migration.case.findUniqueOrThrow({ where: { id: f.caseId } }))
      .status,
  ).toBe('RESOLVED');
  await engine.run(f.merchantId, r.refundOperationId);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .refundedMinor,
  ).toBe(2500n);
  expect(await migration.approval.count({ where: { proposalId: p.id } })).toBe(
    2,
  );
});
it('serializes double acceptance and authorization retries without duplicate reservations', async () => {
  const f = await fixture(),
    p = await offer(f),
    v = await version(f.caseId),
    key = randomUUID(),
    b = {
      contentHash: p.contentHash,
      proposalVersion: p.rowVersion,
      confirm: true,
    };
  const results = (await Promise.all(
    Array.from({ length: 3 }, () =>
      settlements.accept(
        f.customerActor,
        f.caseId,
        p.id,
        b,
        v,
        key,
        new Date(),
      ),
    ),
  )) as { id: string }[];
  expect(new Set(results.map((r) => r.id)).size).toBe(1);
  const authBody = { ...b, proposalVersion: p.rowVersion + 1 },
    authVersion = await version(f.caseId),
    authKey = randomUUID();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      settlements.authorize(
        f.ownerActor,
        f.caseId,
        results[0]!.id,
        authBody,
        authVersion,
        authKey,
        new Date(),
      ),
    ),
  );
  expect(
    await migration.refundOperation.count({ where: { proposalId: p.id } }),
  ).toBe(1);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .reservedMinor,
  ).toBe(2500n);
});
it('rejects stale terms, wrong party, insufficient policy and missing recent merchant authentication', async () => {
  const f = await fixture(),
    p = await offer(f),
    b = {
      contentHash: p.contentHash,
      proposalVersion: p.rowVersion,
      confirm: true,
    };
  await expect(
    settlements.accept(
      f.ownerActor,
      f.caseId,
      p.id,
      b,
      await version(f.caseId),
      randomUUID(),
      new Date(),
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    settlements.accept(
      f.customerActor,
      f.caseId,
      p.id,
      { ...b, contentHash: '0'.repeat(64) },
      await version(f.caseId),
      randomUUID(),
      new Date(),
    ),
  ).rejects.toMatchObject({ code: 'OFFER_NOT_CURRENT' });
  const s = await accept(f, p);
  await expect(
    settlements.authorize(
      f.ownerActor,
      f.caseId,
      s.id,
      { ...b, proposalVersion: p.rowVersion + 1 },
      await version(f.caseId),
      randomUUID(),
      new Date(0),
    ),
  ).rejects.toMatchObject({ code: 'FRESH_AUTHENTICATION_REQUIRED' });
  await cases.comment(
    f.customerActor,
    f.caseId,
    { body: 'New material evidence changes the case.', visibility: 'CUSTOMER' },
    await version(f.caseId),
    randomUUID(),
  );
  await expect(authorize(f, p, s)).rejects.toMatchObject({
    code: 'OFFER_STALE',
  });
  expect(
    await migration.refundOperation.count({ where: { proposalId: p.id } }),
  ).toBe(0);
});
it('retains an uncertain reservation after a lost response and recovers through verified refund lookup, never a second POST', async () => {
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s);
  let posts = 0;
  const factory = (
    a: Parameters<typeof mockRefundProvider>[1],
  ): RefundProvider => {
    const mock = mockRefundProvider(workerDb, a);
    return {
      ...mock,
      refundCapture: async () => {
        posts++;
        throw new PayPalError('TRANSPORT_UNCERTAIN', 0, true, true);
      },
    };
  };
  const engine = new RefundEngine(workerDb, factory);
  await engine.run(f.merchantId, r.refundOperationId);
  expect(
    (
      await migration.refundOperation.findUniqueOrThrow({
        where: { id: r.refundOperationId },
      })
    ).state,
  ).toBe('UNKNOWN');
  const restarted = new RefundEngine(workerDb, factory);
  await restarted.run(f.merchantId, r.refundOperationId);
  expect(posts).toBe(1);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .reservedMinor,
  ).toBe(2500n);
  const id = 'MOCK_' + r.refundOperationId.replaceAll('-', '');
  await restarted.observeWebhook(f.merchantId, f.accountId, id);
  await restarted.observeWebhook(f.merchantId, f.accountId, id);
  expect(posts).toBe(1);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .refundedMinor,
  ).toBe(2500n);
});
it('recovers a crashed lease through the durable outbox/sweeper without Redis being the source of truth', async () => {
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s),
    engine = new RefundEngine(workerDb, (a) => mockRefundProvider(workerDb, a));
  await engine.claim(f.merchantId, r.refundOperationId);
  await migration.refundOperation.update({
    where: { id: r.refundOperationId },
    data: { leaseUntil: new Date(0) },
  });
  const delivery = new PaymentDelivery(
    new PaymentStore(workerDb),
    new PaymentEngine(new PaymentStore(workerDb), () => {
      throw Error('Checkout must not execute');
    }),
    async () => {},
    '0'.repeat(64),
    new RefundEngine(workerDb, (a) => mockRefundProvider(workerDb, a)),
  );
  await delivery.process({
    schemaVersion: 1,
    merchantId: f.merchantId,
    kind: 'refund',
    id: r.refundOperationId,
  });
  expect(
    (
      await migration.refundOperation.findUniqueOrThrow({
        where: { id: r.refundOperationId },
      })
    ).state,
  ).toBe('COMPLETED');
});
it('enforces settlement RLS, worker assignment and immutable consent records without resetting existing data', async () => {
  const f = await fixture(),
    other = await fixture(),
    p = await offer(f),
    s = await accept(f, p);
  await expect(
    settlements.list(other.customerActor, f.caseId),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(
    (
      await workerDb.transaction(other.merchantId, null, (tx) =>
        tx.query('SELECT id FROM "Settlement" WHERE id=$1', [s.id]),
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.transaction(null, null, (tx) =>
        tx.query('SELECT id FROM "Settlement" WHERE id=$1', [s.id]),
      )
    ).rows,
  ).toHaveLength(0);
  await expect(
    db.transaction(f.merchantId, f.customer, (tx) =>
      tx.query(
        'UPDATE "Settlement" SET "contentHash"=\'changed\' WHERE id=$1',
        [s.id],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    db.transaction(f.merchantId, f.customer, (tx) =>
      tx.query('UPDATE "Settlement" SET state=\'COMPLETED\' WHERE id=$1', [
        s.id,
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    db.transaction(f.merchantId, f.customer, (tx) =>
      tx.query('UPDATE "Proposal" SET "completedAt"=now() WHERE id=$1', [p.id]),
    ),
  ).rejects.toThrow();
  await expect(
    db.transaction(f.merchantId, f.customer, (tx) =>
      tx.query(
        'UPDATE "Approval" SET decision=\'REJECT\' WHERE "proposalId"=$1',
        [p.id],
      ),
    ),
  ).rejects.toThrow();
});

it('processes the durable mock job through BullMQ without deleting queues or fixture data', async () => {
  const { startMockRefundWorker } =
    await import('../../apps/worker/src/refund-worker.js');
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s);
  const w = await startMockRefundWorker(env.REDIS_URL, workerDb, {
    prefix: 'phase6-safe-' + randomUUID(),
    intervalMs: 100,
  });
  try {
    await expect
      .poll(
        async () =>
          (
            await migration.refundOperation.findUniqueOrThrow({
              where: { id: r.refundOperationId },
            })
          ).state,
        { timeout: 15000 },
      )
      .toBe('COMPLETED');
  } finally {
    await w.close();
  }
});

it('verifies webhook receipts before refund effects and handles duplicate and out-of-order deliveries', async () => {
  const { encryptReceipt, hashPayload } =
    await import('../../packages/payment-store/dist/index.js');
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s);
  let valid = false,
    posts = 0;
  const paymentStore = new PaymentStore(workerDb),
    provider = (a: Parameters<typeof mockRefundProvider>[1]) => ({
      ...mockRefundProvider(workerDb, a),
      createOrder: async () => {
        throw Error('Forbidden checkout');
      },
      captureOrder: async () => {
        throw Error('Forbidden capture');
      },
      verifyWebhook: async () => valid,
    });
  const refundEngine = new RefundEngine(workerDb, (a) => ({
    ...mockRefundProvider(workerDb, a),
    refundCapture: async () => {
      posts++;
      throw Error('Webhook recovery must not POST');
    },
  }));
  const delivery = new PaymentDelivery(
    paymentStore,
    new PaymentEngine(paymentStore, provider),
    async () => {},
    '0'.repeat(64),
    refundEngine,
  );
  const eventId = 'SYNTHETIC_EVENT_' + randomUUID(),
    raw = JSON.stringify({
      id: eventId,
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'MOCK_' + r.refundOperationId.replaceAll('-', '') },
    });
  const inbox = await migration.webhookInbox.create({
    data: {
      merchantId: f.merchantId,
      accountId: f.accountId,
      providerEventId: eventId,
    },
  });
  const receipt = async (tag: string) =>
    migration.webhookReceipt.create({
      data: {
        merchantId: f.merchantId,
        inboxId: inbox.id,
        originalPayloadEncryptedRef: encryptReceipt(raw, '0'.repeat(64)),
        payloadHash: hashPayload(raw),
        receiptHash: hashPayload(raw + tag),
        redactedHeaders: {
          'paypal-transmission-id': 'synthetic',
          'paypal-transmission-time': new Date().toISOString(),
          'paypal-transmission-sig': 'synthetic-test-only',
          'paypal-cert-url': 'https://api.sandbox.paypal.com/synthetic',
          'paypal-auth-algo': 'SHA256withRSA',
        },
      },
    });
  const bad = await receipt('invalid');
  await delivery.webhook(f.merchantId, bad.id);
  expect(
    (
      await migration.webhookReceipt.findUniqueOrThrow({
        where: { id: bad.id },
      })
    ).verificationStatus,
  ).toBe('REJECTED');
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .refundedMinor,
  ).toBe(0n);
  valid = true;
  const good = await receipt('valid');
  await delivery.webhook(f.merchantId, good.id);
  await delivery.webhook(f.merchantId, good.id);
  expect(
    (
      await migration.webhookInbox.findUniqueOrThrow({
        where: { id: inbox.id },
      })
    ).processingStatus,
  ).toBe('PROCESSED');
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .refundedMinor,
  ).toBe(2500n);
  expect(posts).toBe(0);
  // A stale event cannot override the provider's current completed refund.
  await refundEngine.observeWebhook(
    f.merchantId,
    f.accountId,
    'MOCK_' + r.refundOperationId.replaceAll('-', ''),
  );
  expect(
    (
      await migration.refundOperation.findUniqueOrThrow({
        where: { id: r.refundOperationId },
      })
    ).state,
  ).toBe('COMPLETED');
});

it('keeps completion least-privileged while allowing the required Case version increment', async () => {
  const row = (
    await workerDb.rows<{
      version: boolean;
      description: boolean;
      terms: boolean;
    }>(
      `SELECT has_column_privilege(current_user,'"Case"','version','SELECT') AS version,has_column_privilege(current_user,'"Case"','description','SELECT') AS description,has_column_privilege(current_user,'"Proposal"','termsJson','SELECT') AS terms`,
    )
  )[0];
  expect(row).toEqual({ version: true, description: false, terms: false });
});
it('rolls back a completion persistence failure and reconciles the observed refund without resubmitting', async () => {
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p),
    r = await authorize(f, p, s),
    isolated = new PaymentDatabase(workerUrl);
  let fail = true,
    posts = 0;
  const transaction = isolated.transaction.bind(isolated);
  isolated.transaction = async (m, u, work) =>
    transaction(m, u, async (tx) => {
      const query = tx.query.bind(tx);
      tx.query = (async (...args: Parameters<typeof tx.query>) => {
        if (
          fail &&
          String(args[0]).startsWith('UPDATE "Case" SET status=\'RESOLVED\'')
        ) {
          fail = false;
          throw Object.assign(Error('Synthetic persistence fault'), {
            code: '42501',
          });
        }
        return query(...args);
      }) as typeof tx.query;
      try {
        return await work(tx);
      } finally {
        tx.query = query;
      }
    });
  const provider = (a: Parameters<typeof mockRefundProvider>[1]) => {
    const mock = mockRefundProvider(isolated, a);
    return {
      ...mock,
      refundCapture: async (
        ...args: Parameters<RefundProvider['refundCapture']>
      ) => {
        posts++;
        return mock.refundCapture(...args);
      },
    };
  };
  try {
    const engine = new RefundEngine(isolated, provider);
    await engine.run(f.merchantId, r.refundOperationId);
    const cap = await migration.capture.findUniqueOrThrow({
      where: { id: f.captureId },
    });
    expect(cap.refundedMinor).toBe(0n);
    expect(cap.reservedMinor).toBe(2500n);
    expect(
      (
        await migration.refundOperation.findUniqueOrThrow({
          where: { id: r.refundOperationId },
        })
      ).lastErrorCode,
    ).toBe('REFUND_DB_PERMISSION_DENIED');
    await engine.run(f.merchantId, r.refundOperationId);
    expect(
      (
        await migration.capture.findUniqueOrThrow({
          where: { id: f.captureId },
        })
      ).refundedMinor,
    ).toBe(2500n);
    expect(posts).toBe(1);
  } finally {
    await isolated.close();
  }
});
it('supports authorized replacement shipment and customer receipt without any refund', async () => {
  const f = await fixture();
  const draft = (await negotiation.create(
    f.ownerActor,
    f.caseId,
    {
      kind: 'REPLACEMENT',
      message: 'Synthetic replacement with explicit merchant authorization.',
      itemDescription: 'Synthetic replacement unit',
      shipBy: new Date(Date.now() + 172800000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    await version(f.caseId),
    randomUUID(),
  )) as { id: string; contentHash: string; rowVersion: number };
  const p = (await negotiation.action(
    f.ownerActor,
    f.caseId,
    draft.id,
    {
      action: 'PUBLISH',
      contentHash: draft.contentHash,
      reason: 'Merchant reviewed replacement terms.',
    },
    await version(f.caseId),
    randomUUID(),
  )) as typeof draft;
  const s = await accept(f, p);
  await authorize(f, p, s);
  await expect(
    settlements.fulfillment(
      f.customerActor,
      f.caseId,
      s.id,
      { action: 'RECEIVE' },
      await version(f.caseId),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'SHIPMENT_NOT_RECORDED' });
  await settlements.fulfillment(
    f.ownerActor,
    f.caseId,
    s.id,
    { action: 'SHIP', reference: 'SYNTHETIC_TRACKING_ONLY' },
    await version(f.caseId),
    randomUUID(),
  );
  await settlements.fulfillment(
    f.customerActor,
    f.caseId,
    s.id,
    { action: 'RECEIVE' },
    await version(f.caseId),
    randomUUID(),
  );
  expect(
    (await migration.settlement.findUniqueOrThrow({ where: { id: s.id } }))
      .state,
  ).toBe('COMPLETED');
  expect(
    await migration.refundOperation.count({ where: { proposalId: p.id } }),
  ).toBe(0);
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .refundedMinor,
  ).toBe(0n);
});
it('cancels an unexecuted agreement without changing approvals or reserving funds', async () => {
  const f = await fixture(),
    p = await offer(f),
    s = await accept(f, p);
  await settlements.cancel(
    f.customerActor,
    f.caseId,
    s.id,
    { reason: 'Synthetic cancellation before authorization' },
    await version(f.caseId),
    randomUUID(),
  );
  expect(
    (await migration.proposal.findUniqueOrThrow({ where: { id: p.id } }))
      .status,
  ).toBe('WITHDRAWN');
  expect(await migration.approval.count({ where: { proposalId: p.id } })).toBe(
    1,
  );
  expect(
    (await migration.capture.findUniqueOrThrow({ where: { id: f.captureId } }))
      .reservedMinor,
  ).toBe(0n);
});

it('enforces session, CSRF, exact-version contracts and customer ownership over HTTP', async () => {
  const { createApp } = await import('../../apps/api/src/app.js'),
    { registerAuth } = await import('../../apps/api/src/auth.js'),
    { registerCases } = await import('../../apps/api/src/cases.js');
  const f = await fixture(),
    other = await fixture(),
    p = await offer(f),
    app = await createApp(env, {
      checkDatabase: async () => 1,
      checkRedis: async () => 1,
      close: async () => {},
    });
  await registerAuth(app, runtime, env);
  await registerCases(app, runtime, cases, env);
  const url = `/api/v1/cases/${f.caseId}/proposals/${p.id}/accept`,
    body = {
      contentHash: p.contentHash,
      proposalVersion: p.rowVersion,
      confirm: true,
    };
  const login = async (email: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: env.WEB_ORIGIN },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    return {
      cookie: String(r.headers['set-cookie']).split(';')[0]!,
      origin: env.WEB_ORIGIN,
      'x-csrf-token': r.json().data.csrfToken as string,
      'idempotency-key': randomUUID(),
      'if-match': String(await version(f.caseId)),
    };
  };
  try {
    expect(
      (await app.inject({ method: 'POST', url, payload: body })).statusCode,
    ).toBe(401);
    const headers = await login(f.customerEmail);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'x-csrf-token': 'invalid' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...body, amountMinor: '1' },
        })
      ).statusCode,
    ).toBe(422);
    const foreign = await login(other.customerEmail);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/cases/${f.caseId}/settlements`,
          headers: foreign,
        })
      ).statusCode,
    ).toBe(404);
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/cases/${f.caseId}/settlements/${accepted.json().data.id}/authorize`,
          headers: { ...headers, 'if-match': String(await version(f.caseId)) },
          payload: { ...body, proposalVersion: p.rowVersion + 1 },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});

it('verifies local database, Redis, private storage and real scanner without deleting data', async () => {
  const { Redis } = await import('ioredis'),
    { scan, clamCommand, PrivateStorage, storageEnvSchema } =
      await import('../../packages/case-store/dist/index.js');
  expect((await db.rows<{ ok: number }>('SELECT 1 AS ok'))[0]?.ok).toBe(1);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    expect(await redis.ping()).toBe('PONG');
  } finally {
    await redis.quit();
  }
  const storage = new PrivateStorage(storageEnvSchema.parse(process.env));
  expect(
    (await storage.request('HEAD', storage.env.S3_CLEAN_BUCKET, '')).ok,
  ).toBe(true);
  expect(await clamCommand('PING')).toContain('PONG');
  expect(
    (await scan(Buffer.from('Explicitly synthetic clean evidence.'))).clean,
  ).toBe(true);
  const eicar = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  expect((await scan(eicar)).clean).toBe(false);
});

it('returns a case version consistent with published offers during concurrent publication', async () => {
  const f = await fixture(),
    p = (await negotiation.create(
      f.ownerActor,
      f.caseId,
      {
        kind: 'PARTIAL_REFUND',
        amountMinor: '2500',
        currency: 'USD',
        message: 'Synthetic concurrent publication terms.',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      await version(f.caseId),
      randomUUID(),
    )) as { id: string; contentHash: string };
  const reader = new NegotiationStore(cases),
    context = reader.context.bind(reader);
  let release!: () => void,
    started!: () => void,
    published = false;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      started = resolve;
    });
  reader.context = async (...args) => {
    started();
    await gate;
    return context(...args);
  };
  const reading = reader.list(f.customerActor, f.caseId);
  await ready;
  const publishing = negotiation
    .action(
      f.ownerActor,
      f.caseId,
      p.id,
      {
        action: 'PUBLISH',
        contentHash: p.contentHash,
        reason: 'Synthetic concurrent publication review',
      },
      await version(f.caseId),
      randomUUID(),
    )
    .then((r) => {
      published = true;
      return r;
    });
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(published).toBe(false);
  } finally {
    release();
  }
  const before = await reading;
  await publishing;
  expect(before.caseVersion).toBe(1);
  expect(before.items).toHaveLength(0);
  const after = await negotiation.list(f.customerActor, f.caseId);
  expect(after.caseVersion).toBe(2);
  expect(after.items[0]?.status).toBe('OFFERED');
});
