import { assertDisposableReset } from './helpers.js';
assertDisposableReset();
import { testDatabaseName } from './helpers.js';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PaymentDatabase,
  PaymentStore,
  PaymentEngine,
  PaymentDelivery,
  type PaymentJob,
} from '../../packages/payment-store/dist/index.js';
import {
  PayPalError,
  type PayPalClient,
  type PayPalOrder,
  type PayPalCapture,
  type CreateOrderRequest,
  type WebhookHeaders,
} from '../../packages/paypal-client/dist/index.js';
import { env, runtime, migration, password } from './helpers.js';
import {
  seedDevelopment,
  fixtureIds as ids,
} from '../../apps/api/src/dev-fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerPayments } from '../../apps/api/src/payments.js';
import { startPaymentWorker } from '../../apps/worker/src/payment-worker.js';
const workerUrl = process.env.WORKER_DATABASE_URL;
if (
  !workerUrl ||
  new URL(workerUrl).pathname !== '/' + testDatabaseName ||
  new URL(workerUrl).username !== 'resolve_payments_test'
)
  throw Error('Payment tests require the isolated provisioned worker role');
const apiDb = new PaymentDatabase(env.DATABASE_URL),
  workerDb = new PaymentDatabase(workerUrl),
  apiStore = new PaymentStore(apiDb),
  workerStore = new PaymentStore(workerDb),
  encryptionKey = '1'.repeat(64);
const testEnv = {
  ...env,
  PAYPAL_ENABLED: 'true' as const,
  PAYPAL_CLIENT_ID: 'TEST-PUBLIC',
  PAYPAL_MERCHANT_ID: 'SELLERTEST',
  PAYPAL_WEBHOOK_ID: 'WH-CONFIG',
  WEBHOOK_PAYLOAD_ENCRYPTION_KEY: encryptionKey,
};
const app = await createApp(testEnv, {
  checkDatabase: () => runtime.$queryRaw`SELECT 1`,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, testEnv);
await registerPayments(app, runtime, apiStore, testEnv);
class FakeProvider implements PayPalClient {
  orders = new Map<string, PayPalOrder>();
  captures = new Map<string, PayPalCapture>();
  creates = 0;
  captureCalls = 0;
  verifyCalls = 0;
  loseCaptureResponse = false;
  createTransient = false;
  keys: string[] = [];
  async createOrder(payload: CreateOrderRequest, key: string) {
    this.creates++;
    this.keys.push(key);
    if (this.createTransient)
      throw new PayPalError('TEMPORARY_FAILURE', 503, true, true);
    const id = 'PP' + randomUUID().replaceAll('-', '').slice(0, 20);
    const order: PayPalOrder = {
      id,
      intent: 'CAPTURE',
      status: 'CREATED',
      purchase_units: structuredClone(payload.purchase_units),
      links: [
        {
          rel: 'approve',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + id,
        },
      ],
    };
    this.orders.set(id, order);
    return structuredClone(order);
  }
  async getOrder(id: string) {
    const row = this.orders.get(id);
    if (!row) throw new PayPalError('RESOURCE_NOT_FOUND', 404, false, false);
    return structuredClone(row);
  }
  async captureOrder(id: string, key: string) {
    this.captureCalls++;
    this.keys.push(key);
    const order = this.orders.get(id)!;
    if (order.status === 'COMPLETED')
      throw new PayPalError('ORDER_ALREADY_CAPTURED', 422, false, false);
    if (order.status !== 'APPROVED')
      throw new PayPalError('ORDER_NOT_APPROVED', 422, false, false);
    const capture: PayPalCapture = {
      id: 'CAP' + randomUUID().replaceAll('-', '').slice(0, 18),
      status: 'COMPLETED',
      amount: structuredClone(order.purchase_units![0]!.amount),
      final_capture: true,
      create_time: new Date().toISOString(),
      supplementary_data: { related_ids: { order_id: id } },
    };
    this.captures.set(capture.id, capture);
    order.status = 'COMPLETED';
    order.purchase_units![0]!.payments = {
      captures: [structuredClone(capture)],
    };
    if (this.loseCaptureResponse) {
      this.loseCaptureResponse = false;
      throw new PayPalError('TRANSPORT_UNCERTAIN', 0, true, true);
    }
    return structuredClone(order);
  }
  async getCapture(id: string) {
    const row = this.captures.get(id);
    if (!row) throw new PayPalError('RESOURCE_NOT_FOUND', 404, false, false);
    return structuredClone(row);
  }
  async verifyWebhook(_raw: string, headers: WebhookHeaders) {
    this.verifyCalls++;
    return headers['paypal-transmission-sig'] === 'valid';
  }
  approve(id: string) {
    this.orders.get(id)!.status = 'APPROVED';
  }
}
let fake = new FakeProvider(),
  engine = new PaymentEngine(workerStore, () => fake),
  accountId = '',
  orderId = '',
  loginCounter = 30;
const jobs: PaymentJob[] = [];
let delivery = new PaymentDelivery(
  workerStore,
  engine,
  async (job) => {
    jobs.push(job);
  },
  encryptionKey,
);
beforeAll(async () => {
  await workerDb.assertWorker();
  await migration.$executeRawUnsafe('TRUNCATE TABLE "Merchant","User" CASCADE');
  await seedDevelopment(migration, {
    nodeEnv: 'test',
    enabled: true,
    password,
  });
});
beforeEach(async () => {
  await migration.$executeRawUnsafe(
    'TRUNCATE TABLE "Order","PaymentAccount","OutboxEvent","AuditEvent","IdempotencyRecord" CASCADE',
  );
  fake = new FakeProvider();
  engine = new PaymentEngine(workerStore, () => fake);
  jobs.length = 0;
  delivery = new PaymentDelivery(
    workerStore,
    engine,
    async (job) => {
      jobs.push(job);
    },
    encryptionKey,
  );
  accountId = randomUUID();
  orderId = randomUUID();
  await migration.paymentAccount.create({
    data: {
      id: accountId,
      merchantId: ids.merchant,
      environment: 'sandbox',
      providerMerchantId: 'SELLERTEST',
      credentialSecretRef: 'env:PAYPAL_CLIENT_SECRET',
      webhookId: 'WH-CONFIG',
      accountKey: 'sandbox-test',
      enabled: true,
      workerRoleName: 'resolve_payments_test',
    },
  });
  await migration.order.create({
    data: {
      id: orderId,
      merchantId: ids.merchant,
      customerUserId: ids.customer,
      purchasePolicyVersionId: ids.policy,
      merchantReference: orderId,
      amountMinor: 10000n,
      currency: 'USD',
    },
  });
  await migration.customerOrder.create({
    data: { merchantId: ids.merchant, orderId, userId: ids.customer },
  });
  await migration.orderItem.create({
    data: {
      merchantId: ids.merchant,
      orderId,
      description: 'Synthetic line item',
      quantity: 1,
      unitMinor: 10000n,
      currency: 'USD',
    },
  });
});
afterAll(async () => {
  await app.close();
  await Promise.allSettled([
    apiDb.close(),
    workerDb.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
async function login(email = 'customer@resolveai.test') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '127.0.0.' + loginCounter++,
    headers: { origin: env.WEB_ORIGIN },
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  return {
    cookie: (Array.isArray(header) ? header[0]! : header!).split(';')[0]!,
    csrf: response.json().data.csrfToken as string,
  };
}
async function intent(
  kind: 'CREATE' | 'CAPTURE' = 'CREATE',
  providerOrderId?: string,
  key = randomUUID(),
) {
  const row = await migration.order.findUniqueOrThrow({
    where: { id: orderId },
  });
  return apiStore.requestIntent(
    {
      merchantId: ids.merchant,
      userId: ids.customer,
      orderId,
      key,
      version: row.version,
      ...(providerOrderId ? { providerOrderId } : {}),
    },
    kind,
  );
}
async function prepareCapture() {
  const create = await intent();
  await engine.run(ids.merchant, create.id);
  const persisted = await migration.checkoutOperation.findUniqueOrThrow({
    where: { id: create.id },
  });
  fake.approve(persisted.providerOrderId!);
  const capture = await intent('CAPTURE', persisted.providerOrderId!);
  return { create, capture, providerOrderId: persisted.providerOrderId! };
}
const headers = (signature = 'valid'): WebhookHeaders => ({
  'paypal-transmission-id': 'T' + randomUUID(),
  'paypal-transmission-time': new Date().toISOString(),
  'paypal-transmission-sig': signature,
  'paypal-cert-url':
    'https://api.sandbox.paypal.com/v1/notifications/certs/CERT1',
  'paypal-auth-algo': 'SHA256withRSA',
});
async function receipt(
  eventId: string,
  type: string,
  resourceId: string,
  signature = 'valid',
) {
  const rows = await apiStore.receipt(
    'sandbox-test',
    eventId,
    JSON.stringify({
      id: eventId,
      event_type: type,
      resource: { id: resourceId },
    }),
    headers(signature),
    encryptionKey,
  );
  return rows[0]!.receiptId;
}
it('enforces account-assigned worker RLS, missing context and denied privileged roles', async () => {
  await expect(workerDb.assertWorker()).resolves.toBeUndefined();
  await expect(apiDb.assertWorker()).rejects.toThrow();
  expect(await workerDb.rows('SELECT * FROM "Order"')).toEqual([]);
  expect(await workerStore.accounts()).toHaveLength(1);
  expect(
    await workerDb.transaction(ids.merchant2, null, (tx) =>
      tx.query('SELECT * FROM "Order"').then((r) => r.rows),
    ),
  ).toEqual([]);
  await expect(workerDb.rows('SELECT * FROM "User"')).rejects.toThrow();
  // Phase 6 intentionally grants assigned-account refund access; absent/foreign context still denies rows.
  expect(await workerDb.rows('SELECT * FROM "RefundOperation"')).toEqual([]);
  expect(
    await workerDb.transaction(ids.merchant2, null, (tx) =>
      tx.query('SELECT * FROM "RefundOperation"').then((r) => r.rows),
    ),
  ).toEqual([]);
  await expect(workerDb.rows('SET ROLE resolve_migrator')).rejects.toThrow();
});
it('creates one durable intent/outbox across duplicate and concurrent checkout requests', async () => {
  const key = randomUUID();
  const operations = await Promise.all(
    Array.from({ length: 6 }, () => intent('CREATE', undefined, key)),
  );
  expect(new Set(operations.map((x) => x.id)).size).toBe(1);
  expect(await migration.checkoutOperation.count()).toBe(1);
  expect(await migration.outboxEvent.count()).toBe(1);
  await engine.run(ids.merchant, operations[0]!.id);
  expect(fake.creates).toBe(1);
  const payment = await apiStore.payment(ids.merchant, ids.customer, orderId);
  expect(payment.status).toBe('AWAITING_BUYER_APPROVAL');
});
it('validates ownership, CSRF, amount tampering and provider association at HTTP boundary', async () => {
  const auth = await login(),
    h = {
      cookie: auth.cookie,
      origin: env.WEB_ORIGIN,
      'x-csrf-token': auth.csrf,
      'idempotency-key': randomUUID(),
      'if-match': '0',
    };
  const validUrl = '/api/v1/orders/' + orderId;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: validUrl + '/checkout',
        headers: h,
        payload: { minor: '1' },
      })
    ).statusCode,
  ).toBe(422);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: validUrl + '/checkout',
        headers: { ...h, 'x-csrf-token': 'wrong' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const other = await login('other-customer@resolveai.test');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: validUrl + '/checkout',
        headers: { ...h, cookie: other.cookie, 'x-csrf-token': other.csrf },
        payload: {},
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: validUrl + '/capture',
        headers: h,
        payload: { providerOrderId: 'ARBITRARY' },
      })
    ).statusCode,
  ).toBe(409);
  expect(await migration.checkoutOperation.count()).toBe(0);
});
it('rejects server-side line-item mismatch and stale version without provider calls', async () => {
  await migration.orderItem.updateMany({
    where: { orderId },
    data: { unitMinor: 1n },
  });
  await expect(intent()).rejects.toMatchObject({ code: 'INVALID_ORDER_TOTAL' });
  expect(fake.creates).toBe(0);
  await migration.orderItem.updateMany({
    where: { orderId },
    data: { unitMinor: 10000n },
  });
  await expect(
    apiStore.requestIntent(
      {
        merchantId: ids.merchant,
        userId: ids.customer,
        orderId,
        key: randomUUID(),
        version: 99,
      },
      'CREATE',
    ),
  ).rejects.toMatchObject({ code: 'STALE_VERSION' });
});
it('serializes duplicate/concurrent captures and persists verified gross/currency once', async () => {
  const prepared = await prepareCapture();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      engine.run(ids.merchant, prepared.capture.id),
    ),
  );
  expect(fake.captureCalls).toBe(1);
  expect(await migration.capture.count()).toBe(1);
  const captured = await migration.capture.findFirstOrThrow();
  expect(captured.grossMinor).toBe(10000n);
  expect(captured.currency).toBe('USD');
  expect(captured.verifiedAt).not.toBeNull();
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .paymentState,
  ).toBe('CAPTURED');
  await expect(intent()).rejects.toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
});
it('recovers timeout after successful capture using GET without another capture POST', async () => {
  const prepared = await prepareCapture();
  fake.loseCaptureResponse = true;
  await engine.run(ids.merchant, prepared.capture.id);
  expect(
    (
      await migration.checkoutOperation.findUniqueOrThrow({
        where: { id: prepared.capture.id },
      })
    ).state,
  ).toBe('UNKNOWN');
  expect(await migration.capture.count()).toBe(0);
  await engine.run(ids.merchant, prepared.capture.id);
  expect(fake.captureCalls).toBe(1);
  expect(await migration.capture.count()).toBe(1);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .status,
  ).toBe('PAID');
});
it('recovers worker death after send from expired IN_FLIGHT lease and persisted intent', async () => {
  const prepared = await prepareCapture();
  const claimed = (await workerStore.claim(ids.merchant, prepared.capture.id))!;
  await workerStore.beforePost(claimed);
  await fake.captureOrder(prepared.providerOrderId, claimed.requestId);
  await migration.checkoutOperation.update({
    where: { id: claimed.id },
    data: { leaseUntil: new Date(Date.now() - 1000), nextAttemptAt: null },
  });
  await delivery.tick();
  expect(jobs.some((j) => j.id === claimed.id)).toBe(true);
  const restarted = new PaymentEngine(workerStore, () => fake);
  await restarted.run(ids.merchant, claimed.id);
  expect(fake.captureCalls).toBe(1);
  expect(await migration.capture.count()).toBe(1);
});
it('keeps original mutation key on transient failure and stops after the safe retry window', async () => {
  const create = await intent();
  fake.createTransient = true;
  await engine.run(ids.merchant, create.id);
  await engine.run(ids.merchant, create.id);
  expect(new Set(fake.keys).size).toBe(1);
  await migration.checkoutOperation.update({
    where: { id: create.id },
    data: { retryUntil: new Date(Date.now() - 1000) },
  });
  await engine.run(ids.merchant, create.id);
  expect(fake.creates).toBe(2);
  const op = await migration.checkoutOperation.findUniqueOrThrow({
    where: { id: create.id },
  });
  expect(op.state).toBe('UNKNOWN');
  expect(op.nextAttemptAt).toBeNull();
});
it('never marks paid when verified provider amount, seller or currency conflicts', async () => {
  const prepared = await prepareCapture();
  fake.orders.get(prepared.providerOrderId)!.purchase_units![0]!.amount.value =
    '1.00';
  await engine.run(ids.merchant, prepared.capture.id);
  expect(fake.captureCalls).toBe(0);
  expect(await migration.capture.count()).toBe(0);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .paymentState,
  ).toBe('RECONCILIATION_REQUIRED');
});
it('outbox survives enqueue failure and duplicates after acknowledgement remain harmless', async () => {
  const create = await intent();
  const broken = new PaymentDelivery(
    workerStore,
    engine,
    async (job) => {
      jobs.push(job);
      throw Error('lost enqueue acknowledgement');
    },
    encryptionKey,
  );
  await expect(broken.tick()).rejects.toThrow('lost enqueue acknowledgement');
  expect(
    (await migration.outboxEvent.findFirstOrThrow()).deliveredAt,
  ).toBeNull();
  await migration.outboxEvent.updateMany({
    data: { availableAt: new Date(0) },
  });
  await delivery.tick();
  expect(
    (await migration.outboxEvent.findFirstOrThrow()).deliveredAt,
  ).not.toBeNull();
  for (const job of jobs) await delivery.process(job);
  expect(fake.creates).toBe(1);
  expect(
    (
      await migration.checkoutOperation.findUniqueOrThrow({
        where: { id: create.id },
      })
    ).providerOrderId,
  ).not.toBeNull();
});
it('invalid signature cannot mutate money and a later authentic delivery with same event ID works', async () => {
  const prepared = await prepareCapture(),
    eventId = 'WH-' + randomUUID();
  const invalid = await receipt(
    eventId,
    'CHECKOUT.ORDER.APPROVED',
    prepared.providerOrderId,
    'invalid',
  );
  await delivery.webhook(ids.merchant, invalid);
  expect(fake.captureCalls).toBe(0);
  expect(
    (
      await migration.webhookReceipt.findUniqueOrThrow({
        where: { id: invalid },
      })
    ).verificationStatus,
  ).toBe('REJECTED');
  const valid = await receipt(
    eventId,
    'CHECKOUT.ORDER.APPROVED',
    prepared.providerOrderId,
  );
  await delivery.webhook(ids.merchant, valid);
  expect(fake.captureCalls).toBe(1);
  expect(await migration.capture.count()).toBe(1);
  expect(await migration.webhookInbox.count()).toBe(1);
});
it('duplicate and out-of-order webhooks cannot regress a completed capture', async () => {
  const prepared = await prepareCapture();
  await engine.run(ids.merchant, prepared.capture.id);
  const capture = await migration.capture.findFirstOrThrow();
  const eventId = 'WH-' + randomUUID(),
    raw = JSON.stringify({
      id: eventId,
      event_type: 'PAYMENT.CAPTURE.PENDING',
      resource: { id: capture.providerCaptureId },
    }),
    h = headers();
  const first = await apiStore.receipt(
      'sandbox-test',
      eventId,
      raw,
      h,
      encryptionKey,
    ),
    second = await apiStore.receipt(
      'sandbox-test',
      eventId,
      raw,
      h,
      encryptionKey,
    );
  expect(first[0]!.receiptId).toBe(second[0]!.receiptId);
  await delivery.webhook(ids.merchant, first[0]!.receiptId);
  await delivery.webhook(ids.merchant, first[0]!.receiptId);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .paymentState,
  ).toBe('CAPTURED');
  expect(fake.captureCalls).toBe(1);
  expect(await migration.capture.count()).toBe(1);
});
it('HTTP webhook ingress encrypts raw bytes, bounds headers and grants no signature trust', async () => {
  const created = await intent();
  await engine.run(ids.merchant, created.id);
  const remote = (
    await migration.checkoutOperation.findUniqueOrThrow({
      where: { id: created.id },
    })
  ).providerOrderId!;
  const raw =
    '{ "id":"WH-HTTP", "event_type":"CHECKOUT.ORDER.APPROVED", "resource":{"id":"' +
    remote +
    '"} }';
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/paypal/sandbox-test',
    headers: { 'content-type': 'application/json', ...headers('invalid') },
    payload: raw,
  });
  expect(response.statusCode).toBe(202);
  const saved = await migration.webhookReceipt.findFirstOrThrow();
  expect(saved.originalPayloadEncryptedRef).not.toContain('WH-HTTP');
  expect(saved.verificationStatus).toBe('UNVERIFIED');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/paypal/sandbox-test',
        headers: {
          'content-type': 'application/json',
          ...headers(),
          'paypal-cert-url': 'http://127.0.0.1/private',
        },
        payload: raw,
      })
    ).statusCode,
  ).toBe(400);
});
it('real BullMQ payment worker drains persisted intent with mocked provider', async () => {
  const op = await intent();
  const service = await startPaymentWorker({
    redisUrl: env.REDIS_URL,
    store: workerStore,
    provider: () => fake,
    encryptionKey,
    prefix: 'payment-test-' + randomUUID(),
    intervalMs: 50,
  });
  try {
    await expect
      .poll(
        async () =>
          (
            await migration.checkoutOperation.findUniqueOrThrow({
              where: { id: op.id },
            })
          ).state,
        { timeout: 10000 },
      )
      .toBe('COMPLETED');
    expect(fake.creates).toBe(1);
  } finally {
    await service.close();
  }
});
it('rejects cross-tenant status access and exposes only public SDK configuration', async () => {
  const op = await intent(),
    auth = await login('other-admin@resolveai.test');
  expect(
    (
      await app.inject({
        url: '/api/v1/payment-operations/' + op.id,
        headers: { cookie: auth.cookie },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        url: '/api/v1/orders/' + orderId + '/payments',
        headers: { cookie: auth.cookie },
      })
    ).statusCode,
  ).toBe(404);
  const result = await app.inject({
    url: '/api/v1/paypal/config',
    headers: { cookie: auth.cookie },
  });
  expect(result.statusCode).toBe(200);
  expect(result.body).not.toContain('clientSecret');
  expect(result.body).not.toContain('WORKER_DATABASE_URL');
});
it('HTTP duplicate capture requests map to one logical operation', async () => {
  const create = await intent();
  await engine.run(ids.merchant, create.id);
  const op = await migration.checkoutOperation.findUniqueOrThrow({
    where: { id: create.id },
  });
  fake.approve(op.providerOrderId!);
  const auth = await login(),
    row = await migration.order.findUniqueOrThrow({ where: { id: orderId } });
  const request = {
    method: 'POST' as const,
    url: '/api/v1/orders/' + orderId + '/capture',
    headers: {
      cookie: auth.cookie,
      origin: env.WEB_ORIGIN,
      'x-csrf-token': auth.csrf,
      'idempotency-key': randomUUID(),
      'if-match': String(row.version),
    },
    payload: { providerOrderId: op.providerOrderId },
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => app.inject(request)),
  );
  expect(results.every((r) => r.statusCode === 202)).toBe(true);
  expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
  expect(
    await migration.checkoutOperation.count({ where: { kind: 'CAPTURE' } }),
  ).toBe(1);
});
it('freezes line items and payloads after checkout intent', async () => {
  const op = await intent();
  await expect(
    migration.checkoutOperation.update({
      where: { id: op.id },
      data: { requestHash: 'changed' },
    }),
  ).rejects.toThrow();
  await expect(
    migration.orderItem.updateMany({
      where: { orderId },
      data: { unitMinor: 1n },
    }),
  ).rejects.toThrow();
});
it('refuses to execute a queued intent for a suspended merchant', async () => {
  const op = await intent();
  await migration.merchant.update({
    where: { id: ids.merchant },
    data: { status: 'SUSPENDED' },
  });
  try {
    await engine.run(ids.merchant, op.id);
    expect(fake.creates).toBe(0);
    expect(
      (
        await migration.checkoutOperation.findUniqueOrThrow({
          where: { id: op.id },
        })
      ).state,
    ).toBe('UNKNOWN');
  } finally {
    await migration.merchant.update({
      where: { id: ids.merchant },
      data: { status: 'ACTIVE' },
    });
  }
});
it.each(['currency', 'seller'])(
  'rejects mismatched provider %s',
  async (field) => {
    const prepared = await prepareCapture(),
      unit = fake.orders.get(prepared.providerOrderId)!.purchase_units![0]!;
    if (field === 'currency') unit.amount.currency_code = 'EUR';
    else unit.payee!.merchant_id = 'ANOTHERSELLER';
    await engine.run(ids.merchant, prepared.capture.id);
    expect(fake.captureCalls).toBe(0);
    expect(await migration.capture.count()).toBe(0);
  },
);
it('retries a verified but unfinished inbox receipt after provider-read failure', async () => {
  const prepared = await prepareCapture(),
    id = await receipt(
      'WH-RECOVER',
      'CHECKOUT.ORDER.APPROVED',
      prepared.providerOrderId,
    ),
    original = fake.getOrder.bind(fake);
  fake.getOrder = async () => {
    throw new PayPalError('TEMPORARY_READ_FAILURE', 503, false, true);
  };
  await expect(delivery.webhook(ids.merchant, id)).rejects.toThrow();
  expect(
    (await migration.webhookReceipt.findUniqueOrThrow({ where: { id } }))
      .verificationStatus,
  ).toBe('VERIFIED');
  await delivery.tick();
  expect(jobs.some((j) => j.kind === 'webhook' && j.id === id)).toBe(true);
  fake.getOrder = original;
  await delivery.webhook(ids.merchant, id);
  expect(fake.captureCalls).toBe(1);
});
it('fences stale workers after another worker acquires an expired lease', async () => {
  const op = await intent(),
    old = (await workerStore.claim(ids.merchant, op.id))!;
  await migration.checkoutOperation.update({
    where: { id: op.id },
    data: { leaseUntil: new Date(0) },
  });
  const current = await workerStore.claim(ids.merchant, op.id);
  expect(current?.leaseOwner).not.toBe(old.leaseOwner);
  expect(
    await workerStore.update(old, {
      state: 'COMPLETED',
      paymentState: 'CAPTURED',
      action: 'STALE_WORKER_MUST_NOT_COMMIT',
    }),
  ).toBe(false);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .status,
  ).toBe('UNPAID');
});
it('stops unsafe capture POST retries after deadline but can still recover authoritative success', async () => {
  const prepared = await prepareCapture();
  await migration.checkoutOperation.update({
    where: { id: prepared.capture.id },
    data: { postAttempts: 1, retryUntil: new Date(0) },
  });
  await engine.run(ids.merchant, prepared.capture.id);
  expect(fake.captureCalls).toBe(0);
  const pending = await migration.checkoutOperation.findUniqueOrThrow({
    where: { id: prepared.capture.id },
  });
  expect(pending.state).toBe('UNKNOWN');
  expect(pending.nextAttemptAt).not.toBeNull();
  await fake.captureOrder(prepared.providerOrderId, prepared.capture.requestId);
  await engine.run(ids.merchant, prepared.capture.id);
  expect(await migration.capture.count()).toBe(1);
  expect(fake.captureCalls).toBe(1);
});
it('does not persist pending captures as paid', async () => {
  const prepared = await prepareCapture(),
    original = fake.captureOrder.bind(fake);
  fake.captureOrder = async (id, key) => {
    const result = await original(id, key),
      capture = fake.captures.values().next().value!;
    capture.status = 'PENDING';
    fake.orders.get(id)!.purchase_units![0]!.payments!.captures![0]!.status =
      'PENDING';
    return result;
  };
  await engine.run(ids.merchant, prepared.capture.id);
  expect(await migration.capture.count()).toBe(0);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .paymentState,
  ).toBe('CAPTURE_PENDING');
  fake.captures.values().next().value!.status = 'COMPLETED';
  await engine.run(ids.merchant, prepared.capture.id);
  expect(await migration.capture.count()).toBe(1);
});

it('persists an observed create ID and recovers failed verification by GET only', async () => {
  const create = await intent(),
    original = fake.getOrder.bind(fake);
  fake.getOrder = async () => {
    throw new PayPalError('READ_TIMEOUT', 0, false, true);
  };
  await engine.run(ids.merchant, create.id);
  const uncertain = await migration.checkoutOperation.findUniqueOrThrow({
    where: { id: create.id },
  });
  expect(uncertain.providerOrderId).not.toBeNull();
  expect(uncertain.state).toBe('UNKNOWN');
  expect(fake.creates).toBe(1);
  fake.getOrder = original;
  await engine.run(ids.merchant, create.id);
  expect(fake.creates).toBe(1);
  expect(
    (await migration.order.findUniqueOrThrow({ where: { id: orderId } }))
      .paymentState,
  ).toBe('AWAITING_BUYER_APPROVAL');
});

it('rejects a malformed-signature provider response without poisoning a later valid delivery', async () => {
  const prepared = await prepareCapture(),
    eventId = 'WH-MALFORMED',
    id = await receipt(
      eventId,
      'CHECKOUT.ORDER.APPROVED',
      prepared.providerOrderId,
      'malformed',
    ),
    original = fake.verifyWebhook.bind(fake);
  fake.verifyWebhook = async () => {
    throw new PayPalError('INVALID_REQUEST', 400, false, false);
  };
  await delivery.webhook(ids.merchant, id);
  expect(
    (await migration.webhookReceipt.findUniqueOrThrow({ where: { id } }))
      .verificationStatus,
  ).toBe('REJECTED');
  expect(fake.captureCalls).toBe(0);
  fake.verifyWebhook = original;
  const valid = await receipt(
    eventId,
    'CHECKOUT.ORDER.APPROVED',
    prepared.providerOrderId,
  );
  await delivery.webhook(ids.merchant, valid);
  expect(fake.captureCalls).toBe(1);
});

it('preserves an authentic receipt for retry when OAuth verification infrastructure fails', async () => {
  const prepared = await prepareCapture(),
    id = await receipt(
      'WH-OAUTH-RECOVERY',
      'CHECKOUT.ORDER.APPROVED',
      prepared.providerOrderId,
    ),
    original = fake.verifyWebhook.bind(fake);
  fake.verifyWebhook = async () => {
    throw new PayPalError('OAUTH_REJECTED', 400, false, false);
  };
  await expect(delivery.webhook(ids.merchant, id)).rejects.toMatchObject({
    code: 'OAUTH_REJECTED',
  });
  expect(
    (await migration.webhookReceipt.findUniqueOrThrow({ where: { id } }))
      .verificationStatus,
  ).toBe('UNVERIFIED');
  expect(fake.captureCalls).toBe(0);
  fake.verifyWebhook = original;
  await delivery.webhook(ids.merchant, id);
  expect(fake.captureCalls).toBe(1);
});

it('rejects an authoritative response carrying a different PayPal order ID', async () => {
  const prepared = await prepareCapture(),
    original = fake.getOrder.bind(fake);
  fake.getOrder = async (id) => ({
    ...(await original(id)),
    id: 'DIFFERENT_ORDER_ID',
  });
  await engine.run(ids.merchant, prepared.capture.id);
  expect(fake.captureCalls).toBe(0);
  expect(await migration.capture.count()).toBe(0);
  expect(
    (
      await migration.checkoutOperation.findUniqueOrThrow({
        where: { id: prepared.capture.id },
      })
    ).lastErrorCode,
  ).toBe('PROVIDER_ORDER_ID_MISMATCH');
});
