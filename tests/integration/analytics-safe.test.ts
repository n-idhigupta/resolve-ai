import { testDatabaseName } from './helpers.js';
import { startIntelligenceWorker } from '../../apps/worker/src/intelligence-worker.js';
import { it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from './helpers.js';
import { createHackathonFixture } from '../../scripts/hackathon-fixture.js';
import {
  PaymentDatabase,
  RefundEngine,
  mockRefundProvider,
} from '../../packages/payment-store/dist/index.js';
import {
  AnalyticsStore,
  CaseStore,
  NegotiationStore,
  SettlementStore,
  PrivateStorage,
  storageEnvSchema,
} from '../../packages/case-store/dist/index.js';
import {
  IntelligenceService,
  ContextPreparer,
  MockAIProvider,
} from '../../packages/ai-core/dist/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerAnalytics } from '../../apps/api/src/analytics.js';
import { registerIntelligence } from '../../apps/api/src/intelligence.js';
const key = process.env.AI_ARTIFACT_KEY!;
if (!/^[a-f0-9]{64}$/.test(key))
  throw Error('Configured isolated AI artifact key required');
const db = new PaymentDatabase(env.DATABASE_URL),
  worker = new PaymentDatabase(process.env.WORKER_DATABASE_URL!),
  evidence = new PaymentDatabase(process.env.EVIDENCE_DATABASE_URL!),
  infer = new PaymentDatabase(process.env.AI_DATABASE_URL!),
  analytics = new AnalyticsStore(db),
  cases = new CaseStore(db),
  service = new IntelligenceService(db, key);
for (const url of [
  process.env.WORKER_DATABASE_URL,
  process.env.EVIDENCE_DATABASE_URL,
  process.env.AI_DATABASE_URL,
])
  if (!url || new URL(url).pathname !== '/' + testDatabaseName)
    throw Error('Isolated role URLs required');
const fixture = () =>
    createHackathonFixture(migration, env.DATABASE_URL, key, password, true),
  actor = (f: Awaited<ReturnType<typeof fixture>>, merchant = true) => ({
    merchantId: f.merchantId,
    userId: merchant ? f.owner : f.customer,
  });
const version = async (id: string) =>
  (await migration.case.findUniqueOrThrow({ where: { id } })).version;
afterAll(async () => {
  await Promise.allSettled([
    db.close(),
    worker.close(),
    evidence.close(),
    infer.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
it('calculates empty-safe merchant cohorts and denies customer and cross-tenant metric access', async () => {
  const f = await fixture(),
    other = await fixture(),
    m = await analytics.read(actor(f), {});
  expect(m.complaints.total).toBe(1);
  expect(m.complaints.resolved).toBe(0);
  expect(m.complaints.durationSamples).toBe(0);
  expect(m.complaints.averageResolutionHours).toBeNull();
  expect(m.ai.analyses).toBe(0);
  expect(m.ai.approvalRateBps).toBeNull();
  expect(m.complaints.capturedOrders).toBe(2);
  await expect(analytics.read(actor(f, false), {})).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(
    analytics.read({ ...actor(other), merchantId: f.merchantId }, {}),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const empty = await analytics.read(actor(f), {
    from: '2020-01-01T00:00:00.000Z',
    to: '2020-01-02T00:00:00.000Z',
  });
  expect(empty.complaints.total).toBe(0);
  expect(empty.complaints.resolutionRateBps).toBeNull();
  await expect(
    analytics.read(actor(f), { from: '2020-01-01T00:00:00.000Z' }),
  ).rejects.toMatchObject({ code: 'INVALID_ANALYTICS_RANGE' });
});
it('reports exact mock refund totals and separate settlement authorization metrics', async () => {
  const f = await fixture(),
    negotiation = new NegotiationStore(cases),
    settlements = new SettlementStore(cases);
  const draft = (await negotiation.create(
    actor(f),
    f.caseId,
    {
      kind: 'PARTIAL_REFUND',
      amountMinor: '2500',
      currency: 'USD',
      message: 'Synthetic analytics demonstration terms.',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    await version(f.caseId),
    randomUUID(),
  )) as { id: string; contentHash: string; rowVersion: number };
  const p = (await negotiation.action(
    actor(f),
    f.caseId,
    draft.id,
    {
      action: 'PUBLISH',
      contentHash: draft.contentHash,
      reason: 'Human reviewed synthetic terms',
    },
    await version(f.caseId),
    randomUUID(),
  )) as typeof draft;
  const s = (await settlements.accept(
    actor(f, false),
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
  const op = (await settlements.authorize(
    actor(f),
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
  const pending = await analytics.read(actor(f), {});
  expect(pending.refunds[0]?.pendingMinor).toBe('2500');
  expect(pending.refunds[0]?.completedMinor).toBe('0');
  await new RefundEngine(worker, (a) => mockRefundProvider(worker, a)).run(
    f.merchantId,
    op.refundOperationId,
  );
  const m = await analytics.read(actor(f), {});
  expect(m.complaints.resolutionRateBps).toBe(10000);
  expect(m.complaints.durationSamples).toBe(1);
  expect(m.complaints.averageResolutionHours).toBeGreaterThanOrEqual(0);
  expect(m.settlements.completed).toBe(1);
  expect(m.settlements.merchantFinancialAuthorizations).toBe(1);
  expect(m.refunds[0]).toMatchObject({
    mockCompletedMinor: '2500',
    recordedProviderCompletedMinor: '0',
    pendingMinor: '0',
    unknownMinor: '0',
    completedCount: 1,
  });
  expect(m.ai.approved).toBe(0);
});
it('runs a consented local mock through existing citations, policy and review without external credentials', async () => {
  const f = await fixture(),
    customer = actor(f, false),
    merchant = actor(f),
    ctx = (await service.preview(
      customer,
      f.caseId,
      { evidenceIds: [] },
      randomUUID(),
    )) as { id: string };
  await new ContextPreparer(
    evidence,
    new PrivateStorage(storageEnvSchema.parse(process.env)),
    key,
  ).process(f.merchantId, ctx.id);
  const preview = await service.readPreview(customer, f.caseId, ctx.id);
  expect(preview.state).toBe('READY');
  expect(preview.executionMode).toBe('mock');
  expect(preview.disclosure).toContain('no data is transmitted');
  const consent = await service.consent(customer, f.caseId, {
    contextId: ctx.id,
    sharingPolicyId: preview.sharingPolicyId,
    consentHash: preview.consentHash,
  });
  const run = (await service.start(
    merchant,
    f.caseId,
    consent.id,
    randomUUID(),
    await version(f.caseId),
  )) as { id: string };
  // Simulate a crashed lease; real restricted queue sweeper must recover it.
  await migration.analysis.update({
    where: { id: run.id },
    data: { status: 'RUNNING', leaseUntil: new Date(Date.now() - 1000) },
  });
  const recovery = await startIntelligenceWorker({
    mode: 'infer',
    mockOnly: true,
    databaseUrl: process.env.AI_DATABASE_URL!,
    redisUrl: env.REDIS_URL,
    key,
    provider: new MockAIProvider(),
    prefix: 'phase7-recovery-' + randomUUID(),
    intervalMs: 100,
  });
  try {
    await expect
      .poll(
        async () => (await service.detail(merchant, f.caseId, run.id)).status,
        { timeout: 15000 },
      )
      .toBe('SUCCEEDED');
  } finally {
    await recovery.close();
  }
  const result = await service.detail(merchant, f.caseId, run.id);
  expect(result.status).toBe('SUCCEEDED');
  expect(result.executionMode).toBe('mock');
  expect(result.usage).toMatchObject({
    executionMode: 'mock',
    estimatedMicros: 0,
  });
  expect(result.result?.summary.sourceIds.length).toBeGreaterThan(0);
  await service.review(
    merchant,
    f.caseId,
    run.id,
    {
      action: 'APPROVE',
      reason: 'Explicit merchant review of synthetic facts and policy.',
      candidateId: null,
      rationale: 'A nonbinding internal suggestion only.',
    },
    result.version,
    randomUUID(),
  );
  const m = await analytics.read(merchant, {});
  expect(m.ai).toMatchObject({
    analyses: 1,
    mockAnalyses: 1,
    recommendations: 1,
    reviewed: 1,
    approved: 1,
    approvalRateBps: 10000,
  });
  expect(m.settlements.merchantFinancialAuthorizations).toBe(0);
  expect(
    await migration.refundOperation.count({
      where: { merchantId: f.merchantId },
    }),
  ).toBe(0);
  await service.revoke(customer, f.caseId, consent.id);
  await expect(
    service.review(
      merchant,
      f.caseId,
      run.id,
      {
        action: 'APPROVE',
        reason: 'Revoked consent must block another approval.',
        candidateId: null,
        rationale: 'Blocked',
      },
      result.version + 1,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
it('requires authenticated merchant scope over HTTP and exposes no customer identities', async () => {
  const f = await fixture(),
    app = await createApp(env, {
      checkDatabase: async () => 1,
      checkRedis: async () => 1,
      close: async () => {},
    });
  await registerAuth(app, runtime, env);
  await registerAnalytics(app, runtime, db, env);
  await registerIntelligence(app, runtime, env, service, false);
  const login = async (email: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: env.WEB_ORIGIN },
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    return { cookie: String(r.headers['set-cookie']).split(';')[0]! };
  };
  try {
    const url = `/api/v1/merchants/${f.merchantId}/analytics`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    const customer = await login(f.customerEmail);
    expect((await app.inject({ url, headers: customer })).statusCode).toBe(404);
    const mockConfig = await app.inject({
      url: `/api/v1/ai/config?caseId=${f.caseId}`,
      headers: customer,
    });
    expect(mockConfig.json().data).toMatchObject({
      enabled: true,
      executionMode: 'mock',
    });
    const owner = await login(f.ownerEmail),
      r = await app.inject({ url, headers: owner });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json().data)).not.toContain(f.customerEmail);
    expect(
      (await app.inject({ url: url + '?from=invalid', headers: owner }))
        .statusCode,
    ).toBe(422);
  } finally {
    await app.close();
  }
});
it('enforces demo-marker RLS, migration-only provenance and inference least privilege', async () => {
  const f = await fixture(),
    other = await fixture();
  expect((await db.rows('SELECT * FROM "DemoTenant"')).length).toBe(0);
  await db.transaction(f.merchantId, f.customer, async (tx) => {
    expect(
      (
        await tx.query('SELECT * FROM "DemoTenant" WHERE "merchantId"=$1', [
          f.merchantId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await tx.query('SELECT * FROM "DemoTenant" WHERE "merchantId"=$1', [
          other.merchantId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await tx.query('SELECT mock_context_allowed($1) AS allowed', [
          randomUUID(),
        ])
      ).rows[0].allowed,
    ).toBe(false);
  });
  await expect(
    db.transaction(f.merchantId, f.owner, (tx) =>
      tx.query('INSERT INTO "DemoTenant"("merchantId") VALUES($1)', [
        other.merchantId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    infer.transaction(f.merchantId, null, (tx) =>
      tx.query('SELECT * FROM "Capture"'),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    db.transaction(
      f.merchantId,
      f.owner,
      (tx) =>
        tx.query('UPDATE "Order" SET version=version WHERE id=$1', [
          f.purchaseOrderId,
        ]),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: '25006' });
});
