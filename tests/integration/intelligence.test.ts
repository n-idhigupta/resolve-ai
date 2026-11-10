import { assertDisposableReset } from './helpers.js';
assertDisposableReset();
import { testDatabaseName } from './helpers.js';
import {
  createGeminiProvider,
  GEMINI_MODEL,
  GEMINI_DISCLOSURE,
  geminiWire,
  requestEnvelope,
} from '../../packages/ai-core/dist/index.js';
import {
  encryptReceipt,
  decryptReceipt,
  hashPayload,
} from '../../packages/payment-store/dist/index.js';
import {
  preparedRequest,
  EXTRACTOR_VERSION,
} from '../../packages/ai-core/dist/index.js';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from './helpers.js';
import {
  seedDevelopment,
  fixtureIds as ids,
} from '../../apps/api/src/dev-fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerIntelligence } from '../../apps/api/src/intelligence.js';
import { PaymentDatabase } from '../../packages/payment-store/dist/index.js';
import {
  CaseStore,
  PrivateStorage,
  storageEnvSchema,
  EvidenceProcessor,
  EvidenceService,
  sha,
} from '../../packages/case-store/dist/index.js';
import {
  IntelligenceService,
  ContextPreparer,
  AnalysisEngine,
  MODEL,
  validateCitations,
  sourceSchema,
} from '../../packages/ai-core/dist/index.js';
import {
  startIntelligenceWorker,
  assertInferenceEnvironment,
} from '../../apps/worker/src/intelligence-worker.js';
const aiUrl = process.env.AI_DATABASE_URL;
if (
  !aiUrl ||
  new URL(aiUrl).pathname !== '/' + testDatabaseName ||
  new URL(aiUrl).username !== 'resolve_ai_test'
)
  throw Error('Isolated AI role required');
const encryptionKey = process.env.AI_ARTIFACT_KEY!;
const apiDb = new PaymentDatabase(env.DATABASE_URL),
  aiDb = new PaymentDatabase(aiUrl),
  prepDb = new PaymentDatabase(process.env.EVIDENCE_DATABASE_URL!),
  service = new IntelligenceService(apiDb, encryptionKey),
  cases = new CaseStore(apiDb),
  storage = new PrivateStorage(storageEnvSchema.parse(process.env)),
  preparer = new ContextPreparer(prepDb, storage, encryptionKey),
  evidence = new EvidenceService(cases, storage),
  scanner = new EvidenceProcessor(prepDb, storage);
const customer = { merchantId: ids.merchant, userId: ids.customer },
  owner = { merchantId: ids.merchant, userId: ids.owner },
  agent = { merchantId: ids.merchant, userId: ids.agent };
let caseId = '',
  consentId = '',
  contextId = '';
import { FakeAI } from '../fixtures/ai-provider.js';
const provider = new FakeAI(),
  engine = new AnalysisEngine(aiDb, provider, encryptionKey);
const app = await createApp(env, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerIntelligence(app, runtime, env, service, true);
let ip = 80;
async function auth(email: string) {
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
    'x-csrf-token': r.json().data.csrfToken as string,
    origin: env.WEB_ORIGIN,
  };
}
async function cleanup() {
  for (const row of await migration.evidence.findMany()) {
    await storage.delete(storage.env.S3_QUARANTINE_BUCKET, row.objectKey);
    for (const k of new Set([
      ...row.promotionKeys,
      ...(row.cleanObjectKey ? [row.cleanObjectKey] : []),
    ]))
      await storage.delete(storage.env.S3_CLEAN_BUCKET, k);
  }
}
beforeAll(async () => {
  await apiDb.rows('SELECT 1');
});
beforeEach(async () => {
  await cleanup();
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
      providerMerchantId: 'AISYNTHETIC',
      credentialSecretRef: 'synthetic',
      accountKey: 'ai-test',
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
      providerCaptureId: 'AI_SYNTHETIC_CAPTURE',
      providerOrderId: 'AI_SYNTHETIC_ORDER',
      grossMinor: 10000n,
      currency: 'USD',
      providerStatus: 'COMPLETED',
      completedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  await migration.$executeRawUnsafe(
    'INSERT INTO "AIWorkerTenant"("merchantId","roleName") VALUES($1::uuid,\'resolve_ai_test\')',
    ids.merchant,
  );
  await migration.$executeRawUnsafe(
    'INSERT INTO "EvidenceWorkerTenant"("merchantId","roleName") VALUES($1::uuid,\'resolve_evidence_test\')',
    ids.merchant,
  );
  const c = await cases.create(
    customer,
    {
      orderId: ids.order,
      title: 'Synthetic delivery issue',
      reason: 'ITEM_NOT_RECEIVED',
      description:
        'The synthetic parcel has not arrived at the expected address.',
      requestedOutcome: 'HELP',
    },
    randomUUID(),
  );
  caseId = c.id;
  provider.calls = 0;
  provider.countCalls = 0;
  provider.tokens = 1000;
  provider.candidateKind = 'ESCALATE_TO_HUMAN';
  provider.malformed = false;
  provider.transient = false;
  provider.beforeReturn = undefined;
  await service.sharingPolicy(owner, {
    enabled: true,
    modelId: MODEL,
    dailyBudgetMicros: 5000000,
  });
});
afterAll(async () => {
  await cleanup();
  await app.close();
  await Promise.allSettled([
    apiDb.close(),
    aiDb.close(),
    prepDb.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
async function consent(evidenceIds: string[] = []) {
  const preview = await service.preview(
    customer,
    caseId,
    { evidenceIds },
    randomUUID(),
  );
  contextId = preview.id;
  await preparer.process(ids.merchant, contextId);
  const ready = await service.readPreview(customer, caseId, contextId);
  expect(ready.state).toBe('READY');
  const c = await service.consent(customer, caseId, {
    contextId,
    sharingPolicyId: ready.sharingPolicyId,
    consentHash: ready.consentHash,
  });
  consentId = c.id;
  return ready;
}
async function start() {
  const c = await migration.case.findUniqueOrThrow({ where: { id: caseId } });
  return (await service.start(
    owner,
    caseId,
    consentId,
    randomUUID(),
    c.version,
  )) as { id: string; status: string };
}
it('previews exact allowed content, excludes private notes, binds immutable consent and deduplicates requests', async () => {
  await cases.comment(
    agent,
    caseId,
    { body: 'PRIVATE_MERCHANT_SECRET', visibility: 'INTERNAL' },
    0,
    randomUUID(),
  );
  const preview = await consent();
  expect(JSON.stringify(preview.request)).not.toContain(
    'PRIVATE_MERCHANT_SECRET',
  );
  expect(JSON.stringify(preview.request)).not.toContain('AI_SYNTHETIC_CAPTURE');
  const r = await Promise.all([start(), start()]);
  expect(r[0]!.id).toBe(r[1]!.id);
  await expect(
    migration.aIContext.update({
      where: { id: contextId },
      data: { consentHash: '0'.repeat(64) },
    }),
  ).rejects.toThrow();
});
it('requires consent and denies customer access to merchant analyses at API and RLS levels', async () => {
  await expect(
    service.start(owner, caseId, randomUUID(), randomUUID(), 0),
  ).rejects.toThrow();
  await consent();
  const a = await start();
  const customerAuth = await auth('customer@resolveai.test');
  const r = await app.inject({
    method: 'GET',
    url: `/api/v1/merchants/${ids.merchant}/cases/${caseId}/analyses/${a.id}`,
    headers: customerAuth,
  });
  expect(r.statusCode).toBe(404);
  expect(
    await apiDb
      .transaction(ids.merchant, ids.customer, (tx) =>
        tx.query('SELECT id FROM "Analysis"'),
      )
      .then((r) => r.rows),
  ).toEqual([]);
});
it('runs structured analysis once, records usage/citations, and preserves financial records', async () => {
  await consent();
  const a = await start();
  await Promise.all([
    engine.run(ids.merchant, a.id),
    engine.run(ids.merchant, a.id),
  ]);
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.status).toBe('SUCCEEDED');
  expect(provider.calls).toBe(1);
  expect((await migration.aIUsage.findMany())[0]?.status).toBe('KNOWN');
  expect(
    (await migration.findingReference.findMany())[0]?.analysisSourceId,
  ).toBeTruthy();
  expect((await migration.capture.findFirstOrThrow()).version).toBe(0);
  expect(
    (await migration.case.findUniqueOrThrow({ where: { id: caseId } })).status,
  ).toBe('OPEN');
});
it('revocation before inference sends nothing and after dispatch blocks review', async () => {
  await consent();
  const a = await start();
  await service.revoke(customer, caseId, consentId);
  await engine.run(ids.merchant, a.id);
  expect(provider.countCalls).toBe(0);
  expect(provider.calls).toBe(0);
  expect((await service.detail(owner, caseId, a.id)).status).toBe(
    'NEEDS_REVIEW',
  );
});
it('handles revocation during inference without exposing an approvable result', async () => {
  await consent();
  const a = await start();
  provider.beforeReturn = () =>
    service.revoke(customer, caseId, consentId).then(() => {});
  await engine.run(ids.merchant, a.id);
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.result).toBeNull();
  expect(detail.revoked).toBe(true);
  await expect(
    service.review(
      owner,
      caseId,
      a.id,
      {
        action: 'APPROVE',
        reason: 'Reviewed synthetic evidence',
        candidateId: null,
        rationale: 'Internal only',
      },
      detail.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
it('detects concurrent case edits and prevents stale approval or revision', async () => {
  await consent();
  const a = await start();
  provider.beforeReturn = () =>
    cases
      .comment(
        customer,
        caseId,
        { body: 'New public information.', visibility: 'CUSTOMER' },
        0,
        randomUUID(),
      )
      .then(() => {});
  await engine.run(ids.merchant, a.id);
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.status).toBe('STALE');
  await expect(
    service.review(
      owner,
      caseId,
      a.id,
      {
        action: 'REVISE',
        reason: 'Would override staleness',
        candidateId: 'C1',
        rationale: 'Not allowed',
      },
      detail.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
it('rejects malformed results and oversized input without a generation request', async () => {
  await consent();
  const a = await start();
  provider.tokens = 16001;
  await engine.run(ids.merchant, a.id);
  expect(provider.calls).toBe(0);
  expect((await service.detail(owner, caseId, a.id)).lastErrorCode).toBe(
    'INPUT_BUDGET_EXCEEDED',
  );
});
it('retains unknown usage and recovers a transient provider failure with bounded retries', async () => {
  await consent();
  const a = await start();
  provider.transient = true;
  await engine.run(ids.merchant, a.id);
  expect((await migration.aIUsage.findFirstOrThrow()).status).toBe('UNKNOWN');
  provider.transient = false;
  await migration.analysis.update({
    where: { id: a.id },
    data: { nextAttemptAt: new Date(0) },
  });
  await engine.run(ids.merchant, a.id);
  expect((await service.detail(owner, caseId, a.id)).status).toBe('SUCCEEDED');
  expect(provider.calls).toBe(2);
});
it('denies payment/auth/storage tables to the AI role and denies foreign tenants', async () => {
  for (const table of [
    'Capture',
    'Order',
    'User',
    'Session',
    'Evidence',
    'RefundOperation',
  ])
    await expect(aiDb.rows('SELECT * FROM "' + table + '"')).rejects.toThrow();
  expect(await aiDb.rows('SELECT id FROM "Analysis"')).toEqual([]);
  await consent();
  const a = await start();
  await engine.run(ids.merchant2, a.id);
  expect(provider.calls).toBe(0);
  expect(() =>
    assertInferenceEnvironment({
      AI_DATABASE_URL: 'postgresql://x/x',
      AI_ARTIFACT_KEY: 'x',
      OPENAI_API_KEY: 'fake',
      PAYPAL_CLIENT_SECRET: 'forbidden',
    }),
  ).toThrow('FORBIDDEN_AI_ENVIRONMENT');
});
it('uses real clean storage extraction and actual preparation/inference queues', async () => {
  const bytes = Buffer.from(
    'Synthetic delivery evidence: package awaiting delivery.',
  );
  const r = await cases.evidence(
    customer,
    caseId,
    {
      filename: 'receipt.txt',
      declaredType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    0,
    randomUUID(),
  );
  await evidence.upload(customer, caseId, r.id, bytes);
  const c = await migration.case.findUniqueOrThrow({ where: { id: caseId } });
  await evidence.complete(customer, caseId, r.id, randomUUID(), c.version);
  await scanner.process(ids.merchant, r.id);
  await consent([r.id]);
  const a = await start();
  const worker = await startIntelligenceWorker({
    mode: 'infer',
    databaseUrl: aiUrl!,
    redisUrl: env.REDIS_URL,
    key: encryptionKey,
    provider,
    prefix: 'ai-test-' + randomUUID(),
  });
  try {
    await expect
      .poll(async () => (await service.detail(owner, caseId, a.id)).status, {
        timeout: 20000,
      })
      .toBe('SUCCEEDED');
  } finally {
    await worker.close();
  }
  expect((await migration.evidenceExtraction.findFirstOrThrow()).status).toBe(
    'SUCCEEDED',
  );
});
it('requires owner/approver review and cannot bypass legacy financial constraints', async () => {
  await consent();
  const a = await start();
  await engine.run(ids.merchant, a.id);
  const detail = await service.detail(owner, caseId, a.id);
  await expect(
    service.review(
      agent,
      caseId,
      a.id,
      {
        action: 'APPROVE',
        reason: 'Agent cannot approve',
        candidateId: null,
        rationale: 'Internal only',
      },
      detail.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
  await expect(
    service.review(
      owner,
      caseId,
      a.id,
      {
        action: 'REVISE',
        reason: 'Cannot invent refund',
        candidateId: 'C999',
        rationale: 'No policy entitlement',
      },
      detail.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
  const r = await service.review(
    owner,
    caseId,
    a.id,
    {
      action: 'REVISE',
      reason: 'Need more delivery information',
      candidateId: 'C0',
      rationale: 'Ask for tracking details',
    },
    detail.version,
    randomUUID(),
  );
  expect(r.recommendation.kind).toBe('REQUEST_MORE_INFORMATION');
  expect(
    (await migration.case.findUniqueOrThrow({ where: { id: caseId } })).status,
  ).toBe('OPEN');
});
it('validates source identity, quotes, types and policy source references', async () => {
  const preview = await consent();
  const a = await start();
  await engine.run(ids.merchant, a.id);
  const detail = await service.detail(owner, caseId, a.id);
  const request = preview.request!;
  const c = JSON.parse(
    (request.input[0] as { content: { text: string }[] }).content[0]!.text,
  );
  const sources = c.sources.map((s: Record<string, unknown>) =>
    sourceSchema.parse({
      ...s,
      reference: { caseSourceId: caseId },
      hash: 'hash',
    }),
  );
  const output = structuredClone(detail.result!);
  output.summary.sourceIds = ['S999'];
  expect(() =>
    validateCitations(output, sources, c.constraints.candidates),
  ).toThrow('INVALID_CITATION');
});
it('rejects malformed provider output without persisting a recommendation', async () => {
  await consent();
  const a = await start();
  provider.malformed = true;
  await engine.run(ids.merchant, a.id);
  expect((await service.detail(owner, caseId, a.id)).result).toBeNull();
  expect(await migration.aIRecommendation.count()).toBe(0);
  expect((await migration.aIUsage.findFirstOrThrow()).status).toBe('KNOWN');
});
it('fails closed at a tenant budget limit without contacting the provider', async () => {
  await service.sharingPolicy(owner, {
    enabled: true,
    modelId: MODEL,
    dailyBudgetMicros: 10000,
  });
  await consent();
  const a = await start();
  await engine.run(ids.merchant, a.id);
  expect(provider.countCalls).toBe(0);
  expect(provider.calls).toBe(0);
  expect((await service.detail(owner, caseId, a.id)).lastErrorCode).toBe(
    'AI_BUDGET_EXCEEDED',
  );
});
it('recovery after an expired worker lease is fenced and does not duplicate output', async () => {
  await consent();
  const a = await start();
  await migration.analysis.update({
    where: { id: a.id },
    data: {
      status: 'RUNNING',
      leaseOwner: randomUUID(),
      leaseUntil: new Date(0),
    },
  });
  const worker = await startIntelligenceWorker({
    mode: 'infer',
    databaseUrl: aiUrl!,
    redisUrl: env.REDIS_URL,
    key: encryptionKey,
    provider,
    prefix: 'ai-recovery-' + randomUUID(),
    intervalMs: 100,
  });
  try {
    await expect
      .poll(async () => (await service.detail(owner, caseId, a.id)).status, {
        timeout: 20000,
      })
      .toBe('SUCCEEDED');
  } finally {
    await worker.close();
  }
  expect(await migration.aIRecommendation.count()).toBe(1);
  expect(provider.calls).toBe(1);
});
it('purges expired encrypted payloads while preserving consent and output hashes', async () => {
  await consent();
  const a = await start();
  await engine.run(ids.merchant, a.id);
  const before = await migration.analysis.findUniqueOrThrow({
    where: { id: a.id },
  });
  await migration.aIContext.update({
    where: { id: contextId },
    data: { expiresAt: new Date(0) },
  });
  await aiDb.transaction(ids.merchant, null, (tx) =>
    tx.query('SELECT ai_purge_expired()'),
  );
  const after = await migration.analysis.findUniqueOrThrow({
    where: { id: a.id },
  });
  expect(after.outputEncrypted).toBeNull();
  expect(after.outputHash).toBe(before.outputHash);
  expect(
    (await migration.aIContext.findUniqueOrThrow({ where: { id: contextId } }))
      .requestEncrypted,
  ).toBeNull();
  expect(await migration.aIConsent.count()).toBe(1);
});
it('financial revision obeys the immutable policy cap and becomes unapprovable after payment snapshot changes', async () => {
  const draft = await cases.policy(
    owner,
    'create',
    undefined,
    {
      name: 'Synthetic capped refund policy',
      clauses: [
        {
          clauseKey: 'cap',
          text: 'Review within thirty days; potential refund is capped at USD 25.',
          rules: {
            schemaVersion: 1,
            applicableReasons: ['ITEM_NOT_RECEIVED'],
            allowedRemedies: ['HELP', 'PARTIAL_REFUND', 'FULL_REFUND'],
            complaintWindowDays: 30,
            requiredEvidenceTypes: [],
            maxPartialRefundBps: 5000,
            maxRefundMinor: '2500',
            manualReviewThresholdMinor: null,
            mandatoryHumanReview: false,
            replacementAllowed: false,
          },
        },
      ],
    },
    0,
  );
  const policy = await cases.policy(owner, 'publish', draft.id, {}, 0);
  const account = await migration.paymentAccount.findFirstOrThrow(),
    orderId = randomUUID();
  await migration.order.create({
    data: {
      id: orderId,
      merchantId: ids.merchant,
      customerUserId: ids.customer,
      purchasePolicyVersionId: policy.id,
      merchantReference: 'AI-FINANCIAL-' + randomUUID(),
      amountMinor: 10000n,
      currency: 'USD',
      status: 'PAID',
      paymentState: 'CAPTURED',
    },
  });
  await migration.customerOrder.create({
    data: { merchantId: ids.merchant, orderId, userId: ids.customer },
  });
  const capture = await migration.capture.create({
    data: {
      merchantId: ids.merchant,
      orderId,
      accountId: account.id,
      providerCaptureId: 'SYNTHETIC-' + randomUUID(),
      providerOrderId: 'SYNTHETIC-' + randomUUID(),
      grossMinor: 10000n,
      currency: 'USD',
      providerStatus: 'COMPLETED',
      completedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  const c = await cases.create(
    customer,
    {
      orderId,
      title: 'Synthetic capped financial recommendation',
      reason: 'ITEM_NOT_RECEIVED',
      description:
        'The synthetic parcel remains undelivered after the promised date.',
      requestedOutcome: 'HELP',
    },
    randomUUID(),
  );
  caseId = c.id;
  await consent();
  const a = await start();
  provider.candidateKind = 'PARTIAL_REFUND';
  await engine.run(ids.merchant, a.id);
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.status).toBe('SUCCEEDED');
  const context = await service.readPreview(customer, caseId, contextId);
  const candidates = JSON.parse(
    (context.request!.input[0] as { content: { text: string }[] }).content[0]!
      .text,
  ).constraints.candidates as {
    id: string;
    kind: string;
    amountMinor: string | null;
  }[];
  expect(candidates.some((c) => c.kind === 'FULL_REFUND')).toBe(false);
  const financial = candidates.find((c) => c.kind === 'PARTIAL_REFUND')!;
  const review = await service.review(
    owner,
    caseId,
    a.id,
    {
      action: 'REVISE',
      reason: 'Reviewed the purchase policy cap',
      candidateId: financial.id,
      rationale: 'Internal bounded recommendation',
    },
    detail.version,
    randomUUID(),
  );
  expect(BigInt(review.recommendation.amountMinor)).toBeLessThanOrEqual(2500n);
  // Isolated synthetic test capture only. Never touches the development Sandbox payment.
  await migration.capture.update({
    where: { id: capture.id },
    data: { reconciliationStatus: 'FROZEN', version: { increment: 1 } },
  });
  const changed = await service.detail(owner, caseId, a.id);
  expect(changed.status).toBe('STALE');
  await expect(
    service.review(
      owner,
      caseId,
      a.id,
      {
        action: 'REVISE',
        reason: 'Cannot bypass a stale payment snapshot',
        candidateId: financial.id,
        rationale: 'Must reanalyse',
      },
      changed.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
it('records a sanitized extraction failure and preserves it alongside a successful retry', async () => {
  const bytes = Buffer.from('Synthetic evidence for extraction recovery.');
  const r = await cases.evidence(
    customer,
    caseId,
    {
      filename: 'recovery.txt',
      declaredType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    0,
    randomUUID(),
  );
  await evidence.upload(customer, caseId, r.id, bytes);
  const c = await migration.case.findUniqueOrThrow({ where: { id: caseId } });
  await evidence.complete(customer, caseId, r.id, randomUUID(), c.version);
  await scanner.process(ids.merchant, r.id);
  class UnavailableStorage extends PrivateStorage {
    override async get(): Promise<Buffer<ArrayBuffer>> {
      throw Error('unlogged-storage-details');
    }
  }
  const p = await service.preview(
    customer,
    caseId,
    { evidenceIds: [r.id] },
    randomUUID(),
  );
  await new ContextPreparer(
    prepDb,
    new UnavailableStorage(storage.env),
    encryptionKey,
  ).process(ids.merchant, p.id);
  const failure = await migration.evidenceExtraction.findFirstOrThrow();
  expect(failure.status).toBe('FAILED');
  expect(JSON.stringify(failure.metadataJson)).not.toContain(
    'unlogged-storage-details',
  );
  const next = await service.preview(
    customer,
    caseId,
    { evidenceIds: [r.id] },
    randomUUID(),
  );
  await preparer.process(ids.merchant, next.id);
  expect((await service.readPreview(customer, caseId, next.id)).state).toBe(
    'READY',
  );
  expect(
    (await migration.evidenceExtraction.findMany()).map((x) => x.status).sort(),
  ).toEqual(['FAILED', 'SUCCEEDED']);
});
it('RLS prevents forged customer-consent actors and agent approval inserts', async () => {
  await consent();
  const a = await start();
  await engine.run(ids.merchant, a.id);
  await expect(
    apiDb.transaction(ids.merchant, ids.agent, (tx) =>
      tx.query(
        'INSERT INTO "AIReview"("merchantId","analysisId","caseId",sequence,"actorId",action,reason,recommendation) VALUES($1,$2,$3,1,$4,\'APPROVE\',\'forged\',\'{}\')',
        [ids.merchant, a.id, caseId, ids.agent],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    apiDb.transaction(ids.merchant, ids.customer, (tx) =>
      tx.query(
        'INSERT INTO "AIConsent"("merchantId","caseId","contextId","sharingPolicyId","consentHash","actorId") SELECT "merchantId","caseId","contextId","sharingPolicyId","consentHash",$2 FROM "AIConsent" WHERE id=$1',
        [consentId, ids.owner],
      ),
    ),
  ).rejects.toThrow();
});
it('allows a newly consented identical request after revocation without reusing the revoked result', async () => {
  await consent();
  const first = await start();
  await engine.run(ids.merchant, first.id);
  await service.revoke(customer, caseId, consentId);
  await consent();
  const second = await start();
  expect(second.id).not.toBe(first.id);
  await engine.run(ids.merchant, second.id);
  expect(provider.calls).toBe(2);
  expect((await service.detail(owner, caseId, second.id)).status).toBe(
    'SUCCEEDED',
  );
});
it('denies preparation input rewrites and rejects a forged derivative financial candidate before provider dispatch', async () => {
  const preview = await service.preview(
    customer,
    caseId,
    { evidenceIds: [] },
    randomUUID(),
  );
  contextId = preview.id;
  await expect(
    prepDb.transaction(ids.merchant, null, (tx) =>
      tx.query(
        'UPDATE "AIContext" SET "baseEncrypted"=\'forged\' WHERE id=$1',
        [contextId],
      ),
    ),
  ).rejects.toThrow();
  const row = await migration.aIContext.findUniqueOrThrow({
    where: { id: contextId },
  });
  const base = JSON.parse(decryptReceipt(row.baseEncrypted, encryptionKey));
  const request = preparedRequest(base, base.sources, [], [], base.omissions);
  const content = (request.input[0] as { content: { text: string }[] })
    .content[0]!;
  const context = JSON.parse(content.text);
  context.constraints.candidates.push({
    id: 'C999',
    kind: 'FULL_REFUND',
    amountMinor: '999999',
    currency: 'USD',
  });
  content.text = JSON.stringify(context);
  const consentHash = hashPayload({
    manifest: row.manifest,
    sharingPolicyId: row.sharingPolicyId,
    request,
    extractor: EXTRACTOR_VERSION,
  });
  await prepDb.transaction(ids.merchant, null, (tx) =>
    tx.query(
      'UPDATE "AIContext" SET state=\'READY\',"requestEncrypted"=$2,"catalogEncrypted"=$3,"consentHash"=$4 WHERE id=$1',
      [
        contextId,
        encryptReceipt(JSON.stringify(request), encryptionKey),
        encryptReceipt(JSON.stringify(base.sources), encryptionKey),
        consentHash,
      ],
    ),
  );
  const c = await service.consent(customer, caseId, {
    contextId,
    sharingPolicyId: row.sharingPolicyId,
    consentHash,
  });
  consentId = c.id;
  const a = await start();
  await engine.run(ids.merchant, a.id);
  expect(provider.countCalls).toBe(0);
  expect(provider.calls).toBe(0);
  expect((await service.detail(owner, caseId, a.id)).lastErrorCode).toBe(
    'INVALID_POLICY_CONSTRAINTS',
  );
});
function mockedGemini() {
  return createGeminiProvider('synthetic-never-real', {
    countTokens: async () => ({ totalTokens: 1000 }),
    generateContent: async (args: unknown) => {
      const input = args as { contents: { parts: { text?: string }[] }[] };
      const context = JSON.parse(input.contents[0]!.parts[0]!.text!);
      const result = await provider.analyze(
        requestEnvelope(context, [], GEMINI_MODEL),
      );
      return {
        text: JSON.stringify(result.output),
        modelVersion: GEMINI_MODEL,
        responseId: 'mock-gemini-request',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 0,
        },
      };
    },
  } as never);
}
async function googlePolicy(synthetic = true) {
  if (synthetic)
    await migration.case.update({
      where: { id: caseId },
      data: { aiSyntheticAuthorized: true },
    });
  await service.sharingPolicy(owner, {
    enabled: true,
    modelId: GEMINI_MODEL,
    dailyBudgetMicros: 5000000,
  });
}
it('Gemini requires trusted synthetic provenance and never reuses OpenAI consent', async () => {
  await consent();
  const oldConsent = consentId;
  await googlePolicy(false);
  await expect(
    service.preview(customer, caseId, { evidenceIds: [] }, randomUUID()),
  ).rejects.toThrow('GEMINI SYNTHETIC CASE REQUIRED');
  await expect(
    service.start(owner, caseId, oldConsent, randomUUID(), 0),
  ).rejects.toThrow();
  await expect(
    apiDb.transaction(ids.merchant, ids.owner, (tx) =>
      tx.query('UPDATE "Case" SET "aiSyntheticAuthorized"=true WHERE id=$1', [
        caseId,
      ]),
    ),
  ).rejects.toThrow();
  await migration.case.update({
    where: { id: caseId },
    data: { aiSyntheticAuthorized: true },
  });
  const preview = await consent();
  expect(preview.disclosure).toBe(GEMINI_DISCLOSURE);
  expect(preview.providerId).toBe('gemini');
  expect(preview.providerRequest).toEqual(geminiWire(preview.request!));
  expect(preview.tokenCountRequest).toBeTruthy();
  expect(consentId).not.toBe(oldConsent);
});
it('Gemini synthetic intelligence journey validates citations, budgets, merchant review and financial immutability', async () => {
  await googlePolicy();
  const preview = await consent();
  expect(preview.request!.model).toBe(GEMINI_MODEL);
  const a = await start(),
    g = new AnalysisEngine(aiDb, mockedGemini(), encryptionKey);
  await Promise.all([g.run(ids.merchant, a.id), g.run(ids.merchant, a.id)]);
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.status).toBe('SUCCEEDED');
  expect(provider.calls).toBe(1);
  const usage = await migration.aIUsage.findFirstOrThrow();
  expect(usage.priceVersion).toContain('gemini35flashlite');
  expect(usage.chargedMicros).toBe(550n);
  const result = await service.review(
    owner,
    caseId,
    a.id,
    {
      action: 'APPROVE',
      reason: 'Reviewed synthetic Google findings',
      candidateId: null,
      rationale: 'Nonbinding human escalation only',
    },
    detail.version,
    randomUUID(),
  );
  expect(result.action).toBe('APPROVE');
  expect((await migration.capture.findFirstOrThrow()).version).toBe(0);
  expect(
    (await migration.case.findUniqueOrThrow({ where: { id: caseId } })).status,
  ).toBe('OPEN');
  const user = await auth('customer@resolveai.test');
  expect(
    (
      await app.inject({
        method: 'GET',
        url:
          '/api/v1/merchants/' +
          ids.merchant +
          '/cases/' +
          caseId +
          '/analyses/' +
          a.id,
        headers: user,
      })
    ).statusCode,
  ).toBe(404);
});
it('Gemini revocation and staleness block recommendations and review identically to OpenAI', async () => {
  await googlePolicy();
  await consent();
  const a = await start();
  provider.beforeReturn = () =>
    service.revoke(customer, caseId, consentId).then(() => {});
  await new AnalysisEngine(aiDb, mockedGemini(), encryptionKey).run(
    ids.merchant,
    a.id,
  );
  const detail = await service.detail(owner, caseId, a.id);
  expect(detail.revoked).toBe(true);
  expect(detail.result).toBeNull();
  await expect(
    service.review(
      owner,
      caseId,
      a.id,
      {
        action: 'REVISE',
        reason: 'Cannot override revoked sharing',
        candidateId: 'C0',
        rationale: 'No override',
      },
      detail.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
it('a configured provider mismatch sends nothing and retains provider-bound consent', async () => {
  await googlePolicy();
  await consent();
  const a = await start();
  const mismatched = {
    id: 'openai' as const,
    countInputTokens: provider.countInputTokens.bind(provider),
    analyze: provider.analyze.bind(provider),
  };
  await new AnalysisEngine(aiDb, mismatched, encryptionKey).run(
    ids.merchant,
    a.id,
  );
  expect(provider.countCalls).toBe(0);
  expect(provider.calls).toBe(0);
  expect((await service.detail(owner, caseId, a.id)).lastErrorCode).toBe(
    'PROVIDER_CONFIGURATION_MISMATCH',
  );
});
it('new public content invalidates trusted Gemini synthetic provenance and requires reclassification', async () => {
  await googlePolicy();
  await consent();
  const a = await start();
  await cases.comment(
    customer,
    caseId,
    {
      body: 'New information added after synthetic fixture approval.',
      visibility: 'CUSTOMER',
    },
    0,
    randomUUID(),
  );
  await new AnalysisEngine(aiDb, mockedGemini(), encryptionKey).run(
    ids.merchant,
    a.id,
  );
  expect(provider.calls).toBe(0);
  await expect(
    service.preview(customer, caseId, { evidenceIds: [] }, randomUUID()),
  ).rejects.toThrow('GEMINI SYNTHETIC CASE REQUIRED');
  expect((await service.detail(owner, caseId, a.id)).status).toBe('STALE');
});
it('Gemini uncertain generation retains its budget hold and recovers through the existing bounded retry', async () => {
  await googlePolicy();
  await consent();
  const a = await start(),
    g = new AnalysisEngine(aiDb, mockedGemini(), encryptionKey);
  provider.transient = true;
  await g.run(ids.merchant, a.id);
  expect((await migration.aIUsage.findFirstOrThrow()).status).toBe('UNKNOWN');
  provider.transient = false;
  await migration.analysis.update({
    where: { id: a.id },
    data: { nextAttemptAt: new Date(0) },
  });
  await g.run(ids.merchant, a.id);
  expect((await service.detail(owner, caseId, a.id)).status).toBe('SUCCEEDED');
  expect(provider.calls).toBe(2);
  const budget = await migration.aIBudget.findFirstOrThrow();
  expect(budget.committedMicros).toBe(30550n);
});
