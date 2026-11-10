import { assertDisposableReset } from '../integration/helpers.js';
assertDisposableReset();
import { forward } from '../fixtures/browser-forward.js';
import { registerIntelligence } from '../../apps/api/src/intelligence.js';
import {
  IntelligenceService,
  MODEL,
  GEMINI_MODEL,
  GEMINI_DISCLOSURE,
} from '../../packages/ai-core/dist/index.js';
import { startIntelligenceWorker } from '../../apps/worker/src/intelligence-worker.js';
import { FakeAI } from '../fixtures/ai-provider.js';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from '../integration/helpers.js';
import {
  seedDevelopment,
  fixtureIds as ids,
} from '../../apps/api/src/dev-fixtures.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerCases } from '../../apps/api/src/cases.js';
import { registerOrders } from '../../apps/api/src/orders.js';
import {
  CaseStore,
  PrivateStorage,
  storageEnvSchema,
} from '../../packages/case-store/dist/index.js';
import { PaymentDatabase } from '../../packages/payment-store/dist/index.js';
import { startEvidenceWorker } from '../../apps/worker/src/evidence-worker.js';
const db = new PaymentDatabase(env.DATABASE_URL);
const app = await createApp(env, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerOrders(app, runtime, env);
await registerCases(app, runtime, new CaseStore(db), env);
const intelligence = new IntelligenceService(db, process.env.AI_ARTIFACT_KEY!);
await registerIntelligence(app, runtime, env, intelligence, true);
let preparation: Awaited<ReturnType<typeof startIntelligenceWorker>>;
let inference: Awaited<ReturnType<typeof startIntelligenceWorker>>;
let worker: Awaited<ReturnType<typeof startEvidenceWorker>>;
test.beforeAll(async () => {
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
      providerMerchantId: 'BROWSERSELLER',
      credentialSecretRef: 'synthetic',
      accountKey: 'browser-test',
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
      providerCaptureId: 'BROWSER_SYNTHETIC_CAPTURE',
      providerOrderId: 'BROWSER_SYNTHETIC_ORDER',
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
  await migration.$executeRawUnsafe(
    'INSERT INTO "AIWorkerTenant"("merchantId","roleName") VALUES($1::uuid,\'resolve_ai_test\')',
    ids.merchant,
  );
  await intelligence.sharingPolicy(
    { merchantId: ids.merchant, userId: ids.owner },
    { enabled: true, modelId: MODEL, dailyBudgetMicros: 5000000 },
  );
  preparation = await startIntelligenceWorker({
    mode: 'prepare',
    databaseUrl: process.env.EVIDENCE_DATABASE_URL!,
    redisUrl: env.REDIS_URL,
    key: process.env.AI_ARTIFACT_KEY!,
    prefix: 'browser-prep-' + randomUUID(),
  });
  inference = await startIntelligenceWorker({
    mode: 'infer',
    databaseUrl: process.env.AI_DATABASE_URL!,
    redisUrl: env.REDIS_URL,
    key: process.env.AI_ARTIFACT_KEY!,
    provider: new FakeAI(),
    prefix: 'browser-ai-' + randomUUID(),
  });
  await app.listen({ port: 3104, host: '127.0.0.1' });
  worker = await startEvidenceWorker(
    env.REDIS_URL,
    process.env.EVIDENCE_DATABASE_URL!,
    'browser-' + randomUUID(),
  );
});
test.afterAll(async () => {
  await worker?.close();
  await preparation?.close();
  await inference?.close();
  const storage = new PrivateStorage(storageEnvSchema.parse(process.env));
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
    db.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
test('actual customer-to-merchant journey with private storage and ClamAV', async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  const journeyStarted = Date.now();
  let clientAddress = 2,
    useGemini = false;
  async function intercept(p: typeof page) {
    const sourceAddress = '127.0.0.' + clientAddress++;
    let proxyCookie = '';
    await p.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (
        url.pathname.includes('/checkout') ||
        url.pathname.includes('/capture')
      )
        throw Error('Payment mutation forbidden in Phase4 browser test');
      const response = await forward(req, 3104, sourceAddress, proxyCookie);
      proxyCookie = response.cookie;
      if (
        useGemini &&
        url.pathname === '/api/v1/ai/config' &&
        response.status === 200
      ) {
        const body = JSON.parse(response.body.toString());
        Object.assign(body.data, {
          provider: 'gemini',
          model: GEMINI_MODEL,
          syntheticOnly: true,
          disclosure: GEMINI_DISCLOSURE,
        });
        response.body = Buffer.from(JSON.stringify(body));
      }
      await route.fulfill({
        status: response.status,
        headers: response.headers,
        body: response.body,
      });
    });
  }
  async function login(p: typeof page, email: string) {
    await p.goto('/complaints');
    await p.getByLabel('Email', { exact: true }).fill(email);
    await p.getByLabel('Password', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      p.getByRole('heading', { name: 'My Complaints' }),
    ).toBeVisible();
  }
  async function revokeWithExistingRateLimit() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/revoke'),
      );
      await page
        .getByRole('button', { name: 'Revoke consent', exact: true })
        .click();
      const result = await response;
      if (result.status() !== 429) {
        expect(result.status()).toBe(200);
        return;
      }
      expect(attempt).toBe(0);
      const seconds = Number(result.headers()['retry-after']);
      expect(Number.isFinite(seconds) && seconds >= 0 && seconds <= 65).toBe(
        true,
      );
      await page.waitForTimeout((seconds + 1) * 1000);
    }
  }
  await intercept(page);
  await login(page, 'customer@resolveai.test');
  await page.getByRole('link', { name: 'New complaint', exact: true }).click();
  await page.getByLabel('Order', { exact: true }).selectOption(ids.order);
  await page.getByLabel('Category', { exact: true }).selectOption('DAMAGED');
  await page
    .getByLabel('Title', { exact: true })
    .fill('Browser journey damaged parcel');
  await page
    .getByLabel('Description', { exact: true })
    .fill('The synthetic demonstration parcel arrived damaged in transit.');
  await expect(
    page.getByText('Legacy purchase policy:', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Submit complaint' }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser journey damaged parcel' }),
  ).toBeVisible();
  const path = new URL(page.url()).pathname,
    caseId = path.split('/').pop()!;
  await page.getByLabel('Attach evidence').setInputFiles({
    name: 'delivery.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic delivery record for browser verification.'),
  });
  await expect(
    page.getByRole('link', { name: 'Download delivery.txt' }),
  ).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Download delivery.txt' }),
  ).toBeVisible();
  const merchantContext = await browser.newContext();
  const merchant = await merchantContext.newPage();
  await intercept(merchant);
  await login(merchant, 'support@resolveai.test');
  await merchant.goto(`/merchant/${ids.merchant}/cases/${caseId}`);
  await expect(
    merchant.getByRole('heading', { name: 'Browser journey damaged parcel' }),
  ).toBeVisible();
  await merchant
    .getByLabel('Message', { exact: true })
    .fill('Private damage inspection note');
  await merchant
    .getByLabel('Private merchant note (hidden from customer)')
    .check();
  await merchant
    .getByRole('button', { name: 'Add comment', exact: true })
    .click();
  await expect(
    merchant.getByText('Private damage inspection note', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('Private damage inspection note', { exact: true }),
  ).toHaveCount(0);
  await merchant
    .getByLabel('Message', { exact: true })
    .fill('Please confirm the damaged corner.');
  await merchant
    .getByLabel('Case action', { exact: true })
    .selectOption('REQUEST_INFORMATION');
  await merchant
    .getByRole('button', { name: 'Apply action', exact: true })
    .click();
  await expect(
    merchant.getByText('Please confirm the damaged corner.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByLabel('Message', { exact: true })
    .fill('The upper right corner is damaged.');
  await page.getByLabel('Case action', { exact: true }).selectOption('RESPOND');
  await page.getByRole('button', { name: 'Apply action', exact: true }).click();
  await expect(
    page.getByText('The upper right corner is damaged.', { exact: true }),
  ).toBeVisible();
  // Real HTTP, RLS, storage, ClamAV and queue journey; only the provider is mocked.
  await page.reload();
  await page.getByLabel('delivery.txt', { exact: false }).check();
  await page.getByRole('button', { name: 'Prepare sharing preview' }).click();
  await expect(
    page.getByText('Exact externally transmitted case content'),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByLabel('I reviewed this exact content', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Consent to this preview' }).click();
  await expect(
    page.getByText('Consent recorded.', { exact: false }),
  ).toBeVisible();
  const adminContext = await browser.newContext(),
    admin = await adminContext.newPage();
  await intercept(admin);
  await login(admin, 'admin@resolveai.test');
  await admin.goto('/merchant/' + ids.merchant + '/cases/' + caseId);
  const responsePromise = admin.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.endsWith('/analyses'),
  );
  await admin
    .getByRole('button', { name: 'Request AI analysis', exact: true })
    .click();
  const started = await responsePromise;
  if (started.status() === 429) {
    // Shared loopback IP spans real browser users; honor the existing limiter.
    const delay = Math.min(65, Number(started.headers()['retry-after']) || 60);
    await admin.waitForTimeout(delay * 1000 + 1000);
    await admin
      .getByRole('button', { name: 'Request AI analysis', exact: true })
      .click();
  } else expect(started.status()).toBe(202);
  await expect(
    admin.getByText('AI analysis: succeeded', { exact: false }),
  ).toBeVisible({ timeout: 30000 });
  await admin
    .getByRole('button', { name: 'S001', exact: true })
    .first()
    .click();
  await expect(
    admin.getByRole('complementary', { name: 'Validated citation' }),
  ).toBeVisible();
  await admin
    .getByLabel('Review reason', { exact: true })
    .fill('Reviewed synthetic evidence and policy constraints.');
  await admin
    .getByRole('button', { name: 'Approve internal recommendation' })
    .click();
  await expect(
    admin.getByText('Internal decision recorded.', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('Suggested remedy (nonbinding)', { exact: true }),
  ).toHaveCount(0);
  await revokeWithExistingRateLimit();
  await expect(
    page.getByText('Future transmissions revoked.', { exact: false }),
  ).toBeVisible();
  expect((await migration.capture.findFirstOrThrow()).version).toBe(0);
  // Two full provider journeys share each client's existing limiter: honor its one-minute window.
  await page.waitForTimeout(Math.max(0, 62000 - (Date.now() - journeyStarted)));
  // Second provider uses new synthetic classification, policy and explicit customer consent.
  await migration.case.update({
    where: { id: caseId },
    data: { aiSyntheticAuthorized: true },
  });
  await intelligence.sharingPolicy(
    { merchantId: ids.merchant, userId: ids.owner },
    { enabled: true, modelId: GEMINI_MODEL, dailyBudgetMicros: 5000000 },
  );
  useGemini = true;
  await page.reload();
  await expect(
    page.getByText(
      'Google unpaid mode accepts only trusted synthetic test cases.',
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByLabel('delivery.txt', { exact: false }).check();
  await page.getByRole('button', { name: 'Prepare sharing preview' }).click();
  await expect(
    page.getByText('Provider: Google Gemini', { exact: false }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText(
      'Exact Google SDK generation and token-count arguments (authentication excluded)',
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByLabel('I reviewed this exact content', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Consent to this preview' }).click();
  await expect(
    page.getByText('Consent recorded.', { exact: false }),
  ).toBeVisible();
  await admin.reload();
  await admin
    .getByRole('button', { name: 'Request AI analysis', exact: true })
    .click();
  await expect(
    admin.getByText('AI analysis: succeeded', { exact: false }),
  ).toBeVisible({ timeout: 30000 });
  await admin
    .getByLabel('Review reason', { exact: true })
    .fill('Reviewed synthetic Google result and policy constraints.');
  await admin
    .getByRole('button', { name: 'Approve internal recommendation' })
    .click();
  await expect(
    admin.getByText('Internal decision recorded.', { exact: false }),
  ).toBeVisible();
  expect((await migration.capture.findFirstOrThrow()).version).toBe(0);
  await revokeWithExistingRateLimit();
  await expect(
    page.getByText('Future transmissions revoked.', { exact: false }),
  ).toBeVisible();
  await adminContext.close();
  await merchant.reload();
  await merchant
    .getByLabel('Message', { exact: true })
    .fill('Review completed without a financial agreement.');
  await merchant
    .getByLabel('Case action', { exact: true })
    .selectOption('CLOSE_WITHOUT_AGREEMENT');
  await merchant
    .getByRole('button', { name: 'Apply action', exact: true })
    .click();
  await expect(
    merchant.getByText(
      'Closed without agreement. This is a nonfinancial closure:',
      { exact: false },
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('no refund, payment or settlement was issued.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Attach evidence')).toHaveCount(0);
  await merchantContext.close();
});

test('owner publishes immutable policy through the actual browser workspace', async ({
  page,
}) => {
  let cookie = '';
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      u = new URL(req.url());
    const response = await route.fetch({
      url: 'http://127.0.0.1:3104' + u.pathname + u.search,
      headers: { ...(await req.allHeaders()), ...(cookie ? { cookie } : {}) },
    });
    const set = response.headers()['set-cookie'];
    if (set) cookie = set.split(';')[0]!;
    await route.fulfill({ response });
  });
  await page.goto('/complaints');
  await page.getByLabel('Email', { exact: true }).fill('admin@resolveai.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Policies', exact: true }).click();
  await page
    .getByLabel('Policy name', { exact: true })
    .fill('Browser verified support policy');
  await page
    .getByRole('button', { name: 'Validate and publish', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Published immutable policy',
  );
  await expect(page.getByText('Version 2', { exact: false })).toBeVisible();
  const cases = await migration.case.findMany();
  expect(cases.every((c) => c.policyVersionId === ids.policy)).toBe(true);
});
