import { assertDisposableReset } from './helpers.js';
assertDisposableReset();
type Row = Awaited<ReturnType<typeof migration.proposal.findFirstOrThrow>> & {
  caseVersion?: number;
};
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from './helpers.js';
import {
  seedDevelopment,
  fixtureIds as ids,
} from '../../apps/api/src/dev-fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerCases } from '../../apps/api/src/cases.js';
import { PaymentDatabase } from '../../packages/payment-store/dist/index.js';
import {
  CaseStore,
  NegotiationStore,
} from '../../packages/case-store/dist/index.js';
const db = new PaymentDatabase(env.DATABASE_URL),
  cases = new CaseStore(db),
  store = new NegotiationStore(cases);
const app = await createApp(env, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerCases(app, runtime, cases, env);
const customer = { merchantId: ids.merchant, userId: ids.customer },
  owner = { merchantId: ids.merchant, userId: ids.owner };
let caseId = '',
  ip = 120;
const policy = {
  eligible: true,
  legacy: false,
  allowedRemedies: ['PARTIAL_REFUND', 'FULL_REFUND', 'REPLACEMENT', 'HELP'],
  maxPartialRefundBps: 5000,
  potentialRefundCapMinor: '10000',
  requiredEvidenceTypes: [],
};
const body = () => ({
  kind: 'PARTIAL_REFUND',
  amountMinor: '4000',
  currency: 'USD',
  message: 'Proposed partial refund, no payment executed.',
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
async function version() {
  return (await migration.case.findUniqueOrThrow({ where: { id: caseId } }))
    .version;
}
async function draft() {
  return (await store.create(
    owner,
    caseId,
    body(),
    await version(),
    randomUUID(),
  )) as unknown as Row;
}
async function action(p: Row, act: string, a = owner) {
  return (await store.action(
    a,
    caseId,
    p.id,
    {
      action: act,
      contentHash: p.contentHash,
      reason: 'Explicit manual action',
    },
    await version(),
    randomUUID(),
  )) as unknown as Row;
}
async function offered() {
  return action(await draft(), 'PUBLISH');
}
async function login(email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '127.0.0.' + ip++,
    headers: { origin: env.WEB_ORIGIN },
    payload: { email, password },
  });
  expect(r.statusCode).toBe(200);
  return {
    cookie: String(r.headers['set-cookie']).split(';')[0]!,
    origin: env.WEB_ORIGIN,
    'x-csrf-token': r.json().data.csrfToken,
  };
}
beforeAll(async () => {
  await migration.$executeRawUnsafe('TRUNCATE TABLE "Merchant","User" CASCADE');
  await seedDevelopment(migration, {
    nodeEnv: 'test',
    enabled: true,
    password,
  });
  const account = await migration.paymentAccount.create({
    data: {
      merchantId: ids.merchant,
      environment: 'sandbox',
      providerMerchantId: 'SYNTHETIC_NEGOTIATION_SELLER',
      credentialSecretRef: 'test',
      accountKey: 'negotiation-test',
    },
  });
  await migration.order.update({
    where: { id: ids.order },
    data: { status: 'PAID', paymentState: 'CAPTURED' },
  });
  await migration.capture.create({
    data: {
      merchantId: ids.merchant,
      orderId: ids.order,
      accountId: account.id,
      providerCaptureId: 'SYNTHETIC_NEGOTIATION_CAPTURE',
      providerOrderId: 'SYNTHETIC_NEGOTIATION_ORDER',
      grossMinor: 10000n,
      currency: 'USD',
      providerStatus: 'COMPLETED',
      completedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
});
beforeEach(async () => {
  await migration.case.updateMany({
    data: { status: 'CLOSED_WITHOUT_AGREEMENT', closedAt: new Date() },
  });
  const c = await migration.case.create({
    data: {
      merchantId: ids.merchant,
      orderId: ids.order,
      openedBy: ids.customer,
      policyVersionId: ids.policy,
      reason: 'DAMAGED',
      description: 'Synthetic negotiation fixture only',
      policySnapshot: policy,
    },
  });
  caseId = c.id;
});
afterAll(async () => {
  await app.close();
  await Promise.allSettled([
    db.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
it('publishes a manual offer, hides private drafts, and never writes financial operations', async () => {
  const p = await draft();
  expect((await store.list(customer, caseId)).items).toHaveLength(0);
  const pub = await action(p, 'PUBLISH');
  expect(pub.status).toBe('OFFERED');
  expect((await store.list(customer, caseId)).items).toHaveLength(1);
  expect(await migration.refundOperation.count()).toBe(0);
  expect(await migration.approval.count()).toBe(0);
  expect((await migration.capture.findFirstOrThrow()).reservedMinor).toBe(0n);
});
it('serializes duplicate concurrent drafts and detects changed intent', async () => {
  const b = body(),
    key = randomUUID(),
    v = await version();
  const results = (await Promise.all(
    Array.from({ length: 4 }, () => store.create(owner, caseId, b, v, key)),
  )) as unknown as Row[];
  expect(new Set(results.map((r) => r.id)).size).toBe(1);
  expect(await migration.proposal.count({ where: { caseId } })).toBe(1);
  await expect(
    store.create(owner, caseId, { ...b, message: 'Different intent' }, v, key),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('requires approver publication and makes counters new immutable versions even with hidden drafts', async () => {
  const p = await offered();
  await draft();
  const counter = (await store.create(
    customer,
    caseId,
    { ...body(), amountMinor: '3000' },
    await version(),
    randomUUID(),
    p.id,
  )) as unknown as Row;
  expect(counter.authorRole).toBe('CUSTOMER');
  expect(counter.sequence).toBe(3);
  expect(
    (await migration.proposal.findUniqueOrThrow({ where: { id: p.id } }))
      .status,
  ).toBe('SUPERSEDED');
  const support = await migration.user.findUniqueOrThrow({
    where: { normalizedEmail: 'support@resolveai.test' },
  });
  const d = await draft();
  await expect(
    action(d, 'PUBLISH', { ...owner, userId: support.id }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(action(counter, 'PUBLISH')).rejects.toMatchObject({
    code: 'MERCHANT_DRAFT_REQUIRED',
  });
});
it('allows rejection and withdrawal with immutable history and no implicit agreement', async () => {
  const p = await offered();
  expect((await action(p, 'REJECT', customer)).status).toBe('REJECTED');
  const d = await draft();
  expect((await action(d, 'WITHDRAW')).status).toBe('WITHDRAWN');
  expect((await store.list(customer, caseId)).items.map((r) => r.id)).toEqual([
    p.id,
  ]);
  expect(
    await migration.caseTimelineEvent.count({
      where: { caseId, action: 'PROPOSAL_REJECTED' },
    }),
  ).toBe(1);
});
it('invalidates a draft after material discussion and rejects stale versions/hashes', async () => {
  const p = await draft(),
    v = await version();
  await cases.comment(
    customer,
    caseId,
    { body: 'Additional customer facts', visibility: 'CUSTOMER' },
    v,
    randomUUID(),
  );
  await expect(
    store.action(
      owner,
      caseId,
      p.id,
      { action: 'PUBLISH', contentHash: p.contentHash, reason: 'reviewed' },
      v,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await expect(action(p, 'PUBLISH')).rejects.toMatchObject({
    code: 'OFFER_STALE',
  });
  await expect(
    store.action(
      owner,
      caseId,
      p.id,
      { action: 'PUBLISH', contentHash: '0'.repeat(64), reason: 'reviewed' },
      await version(),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
});
it('enforces expiry at read and action time and persists append-only expiration', async () => {
  const b = { ...body(), expiresAt: new Date(Date.now() + 1000).toISOString() },
    p = (await store.create(
      owner,
      caseId,
      b,
      await version(),
      randomUUID(),
    )) as unknown as Row;
  await new Promise((r) => setTimeout(r, 1100));
  expect((await store.list(owner, caseId)).items[0]?.effectiveStatus).toBe(
    'EXPIRED',
  );
  await expect(action(p, 'PUBLISH')).rejects.toMatchObject({
    code: 'OFFER_EXPIRED',
  });
  expect((await action(p, 'EXPIRE')).status).toBe('EXPIRED');
});
it('enforces RLS for missing context, other customers, foreign tenants and immutable proposal content', async () => {
  const p = await offered();
  expect(
    (
      await db.transaction(null, null, (tx) =>
        tx.query('SELECT id FROM "Proposal"'),
      )
    ).rows,
  ).toHaveLength(0);
  const outsider = await migration.user.findUniqueOrThrow({
    where: { normalizedEmail: 'other-customer@resolveai.test' },
  });
  await expect(
    store.list({ ...customer, userId: outsider.id }, caseId),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    store.list({ ...customer, merchantId: ids.merchant2 }, caseId),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    db.transaction(owner.merchantId, owner.userId, (tx) =>
      tx.query('UPDATE "Proposal" SET "termsJson"=\'{}\' WHERE id=$1', [p.id]),
    ),
  ).rejects.toThrow();
  await expect(
    db.transaction(owner.merchantId, owner.userId, (tx) =>
      tx.query(
        'UPDATE "Proposal" SET status=\'AGREED\',"rowVersion"="rowVersion"+1 WHERE id=$1',
        [p.id],
      ),
    ),
  ).rejects.toThrow();
});
it('prevents conflicting concurrent publication and counter/rejection races', async () => {
  const p = await offered(),
    v = await version();
  const results = await Promise.allSettled([
    store.create(customer, caseId, body(), v, randomUUID(), p.id),
    store.action(
      customer,
      caseId,
      p.id,
      { action: 'REJECT', contentHash: p.contentHash, reason: 'Counter race' },
      v,
      randomUUID(),
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});
it('exposes authenticated HTTP contracts and rejects CSRF, invalid inputs and acceptance', async () => {
  const h = await login('admin@resolveai.test');
  const url = `/api/v1/merchants/${ids.merchant}/cases/${caseId}/proposals`;
  const unauth = await app.inject({ method: 'POST', url, payload: body() });
  expect(unauth.statusCode).toBe(401);
  const headers = {
    ...h,
    'if-match': String(await version()),
    'idempotency-key': randomUUID(),
  };
  const noCsrf = { ...headers, 'x-csrf-token': 'bad' };
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: noCsrf,
        payload: body(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...body(), amountMinor: '999999' },
      })
    ).statusCode,
  ).toBe(422);
  const r = await app.inject({ method: 'POST', url, headers, payload: body() });
  expect(r.statusCode).toBe(201);
  const p = r.json().data;
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/cases/${caseId}/proposals/${p.id}/actions`,
        headers: { ...headers, 'if-match': String(await version()) },
        payload: {
          action: 'ACCEPT',
          contentHash: p.contentHash,
          reason: 'Premature settlement',
        },
      })
    ).statusCode,
  ).toBe(422);
  const c = await login('customer@resolveai.test');
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/cases/${caseId}/proposals`,
        headers: c,
      })
    ).json().data.items,
  ).toHaveLength(0);
});

it('requires explicit applicable purchase-clause permission for replacement, beyond the snapshot remedy list', async () => {
  await expect(
    store.create(
      owner,
      caseId,
      {
        kind: 'REPLACEMENT',
        message: 'Replacement requested for review',
        itemDescription: 'Synthetic replacement',
        shipBy: new Date(Date.now() + 172800000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      await version(),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'POLICY_REPLACEMENT_NOT_PERMITTED' });
});
