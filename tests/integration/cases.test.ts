import { assertDisposableReset } from './helpers.js';
assertDisposableReset();
import { testDatabaseName } from './helpers.js';
import { beforeAll, afterAll, it, expect } from 'vitest';
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
  PrivateStorage,
  storageEnvSchema,
  EvidenceService,
  EvidenceProcessor,
  scan,
  sha,
  clamCommand,
} from '../../packages/case-store/dist/index.js';
import { startEvidenceWorker } from '../../apps/worker/src/evidence-worker.js';
const url = process.env.EVIDENCE_DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== '/' + testDatabaseName ||
  new URL(url).username !== 'resolve_evidence_test'
)
  throw Error('Isolated evidence role required');
const apiDb = new PaymentDatabase(env.DATABASE_URL),
  workerDb = new PaymentDatabase(url),
  store = new CaseStore(apiDb),
  storage = new PrivateStorage(storageEnvSchema.parse(process.env)),
  service = new EvidenceService(store, storage),
  processor = new EvidenceProcessor(workerDb, storage),
  a = { merchantId: ids.merchant, userId: ids.customer };
const app = await createApp(env, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerCases(app, runtime, store, env);
let cookie = '',
  csrf = '',
  caseId = '';
let ip = 50;
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
    csrf: r.json().data.csrfToken as string,
  };
}
const headers = (version = 0, key = randomUUID()) => ({
  cookie,
  origin: env.WEB_ORIGIN,
  'x-csrf-token': csrf,
  'if-match': String(version),
  'idempotency-key': key,
});
const body = {
  orderId: ids.order,
  title: 'Damaged demonstration item',
  reason: 'DAMAGED',
  description: 'The demonstration item arrived damaged in its packaging.',
  requestedOutcome: 'HELP',
};
async function reserve(name: string, bytes: Buffer) {
  const version = await store.tx(
    a,
    async (tx) => (await store.locked(tx, a, caseId)).version as number,
  );
  return (await store.evidence(
    a,
    caseId,
    {
      filename: name,
      declaredType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    version,
    randomUUID(),
  )) as { id: string };
}
async function queue(id: string, bytes: Buffer) {
  await service.upload(a, caseId, id, bytes);
  const version = await store.tx(
    a,
    async (tx) => (await store.locked(tx, a, caseId)).version as number,
  );
  await service.complete(a, caseId, id, randomUUID(), version);
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
      providerMerchantId: 'CASETESTSELLER',
      credentialSecretRef: 'test',
      accountKey: 'case-test',
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
      providerCaptureId: 'SYNTHETIC_CASE_CAPTURE',
      providerOrderId: 'SYNTHETIC_CASE_ORDER',
      grossMinor: 10000n,
      currency: 'USD',
      providerStatus: 'COMPLETED',
      completedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  await migration.$executeRawUnsafe(
    'INSERT INTO "EvidenceWorkerTenant"("merchantId","roleName") VALUES($1::uuid,\'resolve_evidence_test\')',
    ids.merchant,
  );
  const auth = await login('customer@resolveai.test');
  cookie = auth.cookie;
  csrf = auth.csrf;
  await clamCommand('PING');
}, 30000);
afterAll(async () => {
  for (const file of await migration.evidence.findMany()) {
    await storage.delete(storage.env.S3_QUARANTINE_BUCKET, file.objectKey);
    for (const key of new Set([
      ...file.promotionKeys,
      ...(file.cleanObjectKey ? [file.cleanObjectKey] : []),
    ]))
      await storage.delete(storage.env.S3_CLEAN_BUCKET, key);
  }
  await app.close();
  await Promise.allSettled([
    apiDb.close(),
    workerDb.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
it('creates exactly one active case under concurrent submissions and records legacy policy', async () => {
  const key = randomUUID();
  const results = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: headers(0, key),
      payload: body,
    }),
    app.inject({
      method: 'POST',
      url: '/api/v1/cases',
      headers: headers(0, key),
      payload: body,
    }),
  ]);
  expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
  caseId = results[0]!.json().data.id;
  expect(results[1]!.json().data.id).toBe(caseId);
  expect(results[0]!.json().data.policySnapshot.legacy).toBe(true);
});
it('rejects missing CSRF, other-customer ownership and unpaid orders', async () => {
  const other = await login('other-customer@resolveai.test');
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/cases/' + caseId,
        headers: { cookie: other.cookie },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/cases',
        headers: { cookie, origin: env.WEB_ORIGIN },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/cases',
    headers: headers(),
    payload: { ...body, orderId: ids.otherOrder },
  });
  expect(r.statusCode).toBe(404);
});
it('enforces worker privilege and absent/cross-tenant RLS context', async () => {
  await processor.assertSafe();
  expect(await workerDb.rows('SELECT id FROM "Evidence"')).toEqual([]);
  await expect(workerDb.rows('SELECT id FROM "User"')).rejects.toThrow();
  await expect(workerDb.rows('SELECT id FROM "Capture"')).rejects.toThrow();
  expect(
    await store
      .tx({ merchantId: ids.merchant2, userId: ids.customer }, (tx) =>
        tx.query('SELECT id FROM "Case"'),
      )
      .then((r) => r.rows),
  ).toEqual([]);
});
it('real ClamAV clean scan and EICAR malware rejection', async () => {
  expect((await scan(Buffer.from('Harmless evidence text'))).clean).toBe(true);
  const eicar = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  expect((await scan(eicar)).clean).toBe(false);
});
it('uploads, validates, scans and promotes actual private storage bytes once under a race', async () => {
  const bytes = Buffer.from('Delivery receipt: synthetic evidence.');
  const r = await reserve('receipt.txt', bytes);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/cases/${caseId}/evidence/${r.id}/download`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(409);
  await queue(r.id, bytes);
  await Promise.all([
    processor.process(a.merchantId, r.id),
    processor.process(a.merchantId, r.id),
  ]);
  const downloaded = await service.download(a, caseId, r.id);
  expect(downloaded.bytes).toEqual(bytes);
  const row = await migration.evidence.findUniqueOrThrow({
    where: { id: r.id },
  });
  expect(row.scanStatus).toBe('CLEAN');
  expect(row.scannerVersion).toContain('ClamAV');
  expect(
    (
      await fetch(
        new URL(
          '/' + storage.env.S3_CLEAN_BUCKET + '/' + row.cleanObjectKey,
          storage.env.S3_ENDPOINT,
        ),
      )
    ).ok,
  ).toBe(false);
});
it('rejects malicious text and forged hashes without downloadable content', async () => {
  const malware = Buffer.from(
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  );
  const r = await reserve('bad.txt', malware);
  await queue(r.id, malware);
  await processor.process(a.merchantId, r.id);
  expect(
    (await migration.evidence.findUniqueOrThrow({ where: { id: r.id } }))
      .scanStatus,
  ).toBe('REJECTED');
  await expect(service.download(a, caseId, r.id)).rejects.toThrow();
  const other = await reserve('hash.txt', Buffer.from('expected'));
  await expect(
    service.upload(a, caseId, other.id, Buffer.from('tampered')),
  ).rejects.toThrow();
});
it('blocks upload overwrite and cleans abandoned real objects safely', async () => {
  const bytes = Buffer.from('Abandoned receipt');
  const r = await reserve('abandoned.txt', bytes);
  await service.upload(a, caseId, r.id, bytes);
  await expect(service.upload(a, caseId, r.id, bytes)).rejects.toThrow();
  await migration.evidence.update({
    where: { id: r.id },
    data: { createdAt: new Date(Date.now() - 2 * 86400000) },
  });
  await Promise.all([
    processor.cleanup(a.merchantId),
    processor.cleanup(a.merchantId),
  ]);
  expect(
    (await migration.evidence.findUniqueOrThrow({ where: { id: r.id } }))
      .uploadState,
  ).toBe('EXPIRED');
  const row = await migration.evidence.findUniqueOrThrow({
    where: { id: r.id },
  });
  await expect(
    storage.get(storage.env.S3_QUARANTINE_BUCKET, row.objectKey),
  ).rejects.toThrow();
});
it('recovers queued evidence through the actual BullMQ worker after startup', async () => {
  const bytes = Buffer.from('Queued before worker startup');
  const r = await reserve('recovered.txt', bytes);
  await queue(r.id, bytes);
  await migration.evidence.update({
    where: { id: r.id },
    data: {
      uploadState: 'PROCESSING',
      leaseOwner: randomUUID(),
      leaseUntil: new Date(0),
    },
  });
  const worker = await startEvidenceWorker(
    env.REDIS_URL,
    url!,
    'phase4-' + randomUUID(),
  );
  try {
    await expect
      .poll(
        async () =>
          (await migration.evidence.findUniqueOrThrow({ where: { id: r.id } }))
            .uploadState,
        { timeout: 20000 },
      )
      .toBe('AVAILABLE');
  } finally {
    await worker.close();
  }
});
it('keeps merchant notes private at API and database layers and validates transitions', async () => {
  const agent = await login('support@resolveai.test');
  let c = (
    await app.inject({
      method: 'GET',
      url: '/api/v1/cases/' + caseId,
      headers: { cookie: agent.cookie },
    })
  ).json().data;
  const note = await app.inject({
    method: 'POST',
    url: `/api/v1/cases/${caseId}/comments`,
    headers: {
      ...headers(c.version),
      cookie: agent.cookie,
      'x-csrf-token': agent.csrf,
    },
    payload: { body: 'PRIVATE_CASE_NOTE', visibility: 'INTERNAL' },
  });
  expect(note.statusCode).toBe(200);
  const comments = await app.inject({
    method: 'GET',
    url: `/api/v1/cases/${caseId}/comments`,
    headers: { cookie },
  });
  expect(comments.body).not.toContain('PRIVATE_CASE_NOTE');
  expect(
    await store
      .tx(a, (tx) =>
        tx.query('SELECT * FROM "CaseComment" WHERE visibility=\'INTERNAL\''),
      )
      .then((r) => r.rows),
  ).toEqual([]);
  c = (
    await app.inject({
      method: 'GET',
      url: '/api/v1/cases/' + caseId,
      headers: { cookie: agent.cookie },
    })
  ).json().data;
  const request = await app.inject({
    method: 'POST',
    url: `/api/v1/merchants/${ids.merchant}/cases/${caseId}/actions`,
    headers: {
      ...headers(c.version),
      cookie: agent.cookie,
      'x-csrf-token': agent.csrf,
    },
    payload: {
      action: 'REQUEST_INFORMATION',
      message: 'Please describe the damage.',
    },
  });
  expect(request.statusCode).toBe(200);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/cases/${caseId}/actions`,
    headers: headers(request.json().data.version),
    payload: { action: 'RESPOND', message: 'The outer packaging was crushed.' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data.status).toBe('INVESTIGATING');
});
it('publishes owner-only immutable policies without replacing the purchase snapshot', async () => {
  const doc = {
    name: 'Demo purchase policy',
    clauses: [
      {
        clauseKey: 'standard',
        text: 'Manual review within thirty days.',
        rules: {
          schemaVersion: 1,
          applicableReasons: ['DAMAGED', 'OTHER'],
          allowedRemedies: ['HELP'],
          complaintWindowDays: 30,
          requiredEvidenceTypes: [],
          maxPartialRefundBps: null,
          maxRefundMinor: null,
          manualReviewThresholdMinor: null,
          mandatoryHumanReview: true,
          replacementAllowed: false,
        },
      },
    ],
  };
  const agent = await login('support@resolveai.test');
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/v1/merchants/${ids.merchant}/policies/drafts`,
        headers: {
          ...headers(),
          cookie: agent.cookie,
          'x-csrf-token': agent.csrf,
        },
        payload: doc,
      })
    ).statusCode,
  ).toBe(403);
  const owner = { merchantId: ids.merchant, userId: ids.owner };
  const draft = await store.policy(owner, 'create', undefined, doc, 0);
  const published = await store.policy(owner, 'publish', draft.id, {}, 0);
  await expect(
    migration.policyVersion.update({
      where: { id: published.id },
      data: { contentHash: 'tampered' },
    }),
  ).rejects.toThrow();
  const c = await migration.case.findUniqueOrThrow({ where: { id: caseId } });
  expect(c.policyVersionId).toBe(ids.policy);
});
it('retains quarantine during scanner outage and rejects MIME spoofing', async () => {
  const bytes = Buffer.from('Not a PNG image');
  const version = (
    await migration.case.findUniqueOrThrow({ where: { id: caseId } })
  ).version;
  const r = (await store.evidence(
    a,
    caseId,
    {
      filename: 'spoof.png',
      declaredType: 'image/png',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
    },
    version,
    randomUUID(),
  )) as { id: string };
  await queue(r.id, bytes);
  const saved = process.env.CLAMAV_PORT;
  process.env.CLAMAV_PORT = '1';
  try {
    await expect(processor.process(a.merchantId, r.id)).rejects.toThrow();
  } finally {
    if (saved === undefined) delete process.env.CLAMAV_PORT;
    else process.env.CLAMAV_PORT = saved;
  }
  let row = await migration.evidence.findUniqueOrThrow({ where: { id: r.id } });
  expect(row.scanStatus).toBe('QUARANTINED');
  await expect(service.download(a, caseId, r.id)).rejects.toThrow();
  await migration.evidence.update({
    where: { id: r.id },
    data: { nextAttemptAt: new Date(0) },
  });
  await processor.process(a.merchantId, r.id);
  row = await migration.evidence.findUniqueOrThrow({ where: { id: r.id } });
  expect(row.scanStatus).toBe('REJECTED');
});
it('fences expired promotion leases and cleans real orphaned promotion objects', async () => {
  const bytes = Buffer.from('Promotion race synthetic receipt');
  const r = await reserve('race.txt', bytes);
  await queue(r.id, bytes);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  class DelayedStorage extends PrivateStorage {
    override async put(bucket: string, key: string, data: Buffer) {
      if (bucket === this.env.S3_CLEAN_BUCKET) {
        entered();
        await gate;
      }
      return super.put(bucket, key, data);
    }
  }
  const delayed = new EvidenceProcessor(
    workerDb,
    new DelayedStorage(storage.env),
  );
  const first = delayed.process(a.merchantId, r.id);
  await started;
  await migration.evidence.update({
    where: { id: r.id },
    data: { leaseUntil: new Date(0) },
  });
  await processor.process(a.merchantId, r.id);
  release();
  await first;
  expect((await service.download(a, caseId, r.id)).bytes).toEqual(bytes);
  await processor.cleanup(a.merchantId);
  const row = await migration.evidence.findUniqueOrThrow({
    where: { id: r.id },
  });
  expect(row.promotionKeys).toEqual([row.cleanObjectKey]);
});
it('protects an in-flight real upload against cleanup and concurrent overwrite', async () => {
  const bytes = Buffer.from('Upload cleanup race receipt');
  const r = await reserve('upload-race.txt', bytes);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  class DelayedStorage extends PrivateStorage {
    override async put(bucket: string, key: string, data: Buffer) {
      entered();
      await gate;
      return super.put(bucket, key, data);
    }
  }
  const uploading = new EvidenceService(
    store,
    new DelayedStorage(storage.env),
  ).upload(a, caseId, r.id, bytes);
  await started;
  await migration.evidence.update({
    where: { id: r.id },
    data: { createdAt: new Date(Date.now() - 2 * 86400000) },
  });
  await processor.cleanup(a.merchantId);
  await expect(service.upload(a, caseId, r.id, bytes)).rejects.toThrow();
  release();
  await uploading;
  expect(
    (await migration.evidence.findUniqueOrThrow({ where: { id: r.id } }))
      .uploadState,
  ).toBe('UPLOADED');
});
it('denies internal timeline and case mutation across tenants and enforces immutable history', async () => {
  await expect(
    store.tx(a, (tx) =>
      tx.query(
        'UPDATE "CaseTimelineEvent" SET action=\'FORGED\' WHERE "caseId"=$1',
        [caseId],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    store.tx(a, (tx) =>
      tx.query('UPDATE "Case" SET "policyVersionId"=$2 WHERE id=$1', [
        caseId,
        ids.policy2,
      ]),
    ),
  ).rejects.toThrow();
  expect(
    await workerDb
      .transaction(ids.merchant2, null, (tx) =>
        tx.query('SELECT id FROM "Evidence"'),
      )
      .then((r) => r.rows),
  ).toEqual([]);
  const other = { merchantId: ids.merchant, userId: ids.otherCustomer };
  await expect(
    store.tx(other, (tx) =>
      tx.query(
        'INSERT INTO "Evidence"("merchantId","caseId","uploaderUserId","objectKey",filename,"sizeBytes",sha256) VALUES($1,$2,$3,$4,\'x.txt\',1,$5)',
        [ids.merchant, caseId, ids.otherCustomer, randomUUID(), '0'.repeat(64)],
      ),
    ),
  ).rejects.toThrow();
});
it('closes nonfinancially, prevents stale updates and applies repeat cooldown', async () => {
  const c = await migration.case.findUniqueOrThrow({ where: { id: caseId } });
  await expect(
    store.action(
      a,
      caseId,
      { action: 'WITHDRAW', message: 'No further review needed' },
      c.version - 1,
      randomUUID(),
    ),
  ).rejects.toThrow();
  const closed = await store.action(
    a,
    caseId,
    { action: 'WITHDRAW', message: 'No further review needed' },
    c.version,
    randomUUID(),
  );
  expect(closed.status).toBe('CLOSED_WITHOUT_AGREEMENT');
  await expect(store.create(a, body, randomUUID())).rejects.toThrow();
  await expect(
    store.comment(
      a,
      caseId,
      { body: 'too late', visibility: 'CUSTOMER' },
      closed.version,
      randomUUID(),
    ),
  ).rejects.toThrow();
});
