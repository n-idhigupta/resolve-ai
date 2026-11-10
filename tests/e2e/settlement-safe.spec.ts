import { testDatabaseName } from '../integration/helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration } from '../integration/helpers.js';
import { createSettlementFixture } from '../../scripts/settlement-fixture.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerCases } from '../../apps/api/src/cases.js';
import { CaseStore } from '../../packages/case-store/dist/index.js';
import { PaymentDatabase } from '../../packages/payment-store/dist/index.js';
import { startMockRefundWorker } from '../../apps/worker/src/refund-worker.js';
import { createHackathonFixture } from '../../scripts/hackathon-fixture.js';
import { registerAnalytics } from '../../apps/api/src/analytics.js';
import { registerIntelligence } from '../../apps/api/src/intelligence.js';
import { registerOrders } from '../../apps/api/src/orders.js';
import {
  PrivateStorage,
  storageEnvSchema,
} from '../../packages/case-store/dist/index.js';
import {
  IntelligenceService,
  ContextPreparer,
  AnalysisEngine,
  MockAIProvider,
} from '../../packages/ai-core/dist/index.js';
import { forward } from '../fixtures/browser-forward.js';
const password = 'synthetic-phase6-browser-password-only',
  db = new PaymentDatabase(env.DATABASE_URL),
  workerDb = new PaymentDatabase(process.env.WORKER_DATABASE_URL!);
if (
  new URL(process.env.WORKER_DATABASE_URL!).pathname !==
  '/' + testDatabaseName
)
  throw Error('Isolated database required');
const app = await createApp(env, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
await registerAuth(app, runtime, env);
await registerCases(app, runtime, new CaseStore(db), env);
const key = process.env.AI_ARTIFACT_KEY!;
const service = new IntelligenceService(db, key);
await registerAnalytics(app, runtime, db, env);
await registerIntelligence(app, runtime, env, service, false);
await registerOrders(app, runtime, env);
let f: Awaited<ReturnType<typeof createSettlementFixture>>,
  worker: Awaited<ReturnType<typeof startMockRefundWorker>>,
  ip = 60;
test.beforeAll(async () => {
  f = await createSettlementFixture(migration, password);
  await app.listen({ host: '127.0.0.1', port: 3116 });
  worker = await startMockRefundWorker(env.REDIS_URL, workerDb, {
    prefix: 'phase6-browser-' + randomUUID(),
    intervalMs: 100,
  });
});
test.afterAll(async () => {
  await worker?.close();
  await app.close();
  await Promise.allSettled([
    db.close(),
    workerDb.close(),
    runtime.$disconnect(),
    migration.$disconnect(),
  ]);
});
async function intercept(p: Page) {
  const address = '127.0.0.' + ip++;
  let cookie = '';
  await p.route('**/api/v1/**', async (route) => {
    if (
      /\/(capture|checkout)(\/|$)/.test(new URL(route.request().url()).pathname)
    )
      throw Error('PayPal mutation forbidden');
    const result = await forward(route.request(), 3116, address, cookie);
    cookie = result.cookie;
    await route.fulfill({
      status: result.status,
      headers: result.headers,
      body: result.body,
    });
  });
}
async function login(p: Page, email: string, path: string) {
  await intercept(p);
  await p.goto(path);
  await p.getByLabel('Email', { exact: true }).fill(email);
  await p.getByLabel('Password', { exact: true }).fill(password);
  await p.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    p.getByRole('heading', { name: 'Negotiation & settlement' }),
  ).toBeVisible();
}
test('real customer and merchant negotiate, confirm exact terms and finish a queued mock settlement', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  await login(
    page,
    f.ownerEmail,
    `/merchant/${f.merchantId}/cases/${f.caseId}`,
  );
  await page
    .getByLabel('Customer-visible terms')
    .fill('We propose a synthetic partial refund for your review.');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish offer #1' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publish offer #1' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish offer #1' }),
  ).toHaveCount(0);
  const context = await browser.newContext(),
    customer = await context.newPage();
  await login(customer, f.customerEmail, `/complaints/${f.caseId}`);
  await customer.getByRole('button', { name: 'Counter offer #1' }).click();
  await customer.getByLabel('Amount (USD)').fill('20.00');
  await customer
    .getByLabel('Customer-visible terms')
    .fill('Could we agree to this synthetic counteroffer?');
  await customer.getByRole('button', { name: 'Submit counteroffer' }).click();
  await expect(customer.getByText('Offer #2: partial refund')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh offers' }).click();
  await expect(page.getByText('Offer #2: partial refund')).toBeVisible();
  await page.getByLabel('Amount (USD)').fill('22.50');
  await page
    .getByLabel('Customer-visible terms')
    .fill('Revised synthetic terms after reviewing your counteroffer.');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await page.getByRole('button', { name: 'Publish offer #3' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish offer #3' }),
  ).toHaveCount(0);
  await customer.getByRole('button', { name: 'Refresh offers' }).click();
  await customer.getByRole('button', { name: 'Review acceptance' }).click();
  const c = customer.getByRole('dialog');
  await expect(c).toContainText('USD 22.50');
  await expect(
    c.getByRole('button', { name: 'Confirm customer acceptance' }),
  ).toBeDisabled();
  await c.getByRole('checkbox').check();
  await c.getByRole('button', { name: 'Confirm customer acceptance' }).click();
  await expect(customer.getByTestId('settlement-status')).toContainText(
    'Awaiting separate merchant authorization',
  );
  await page.getByRole('button', { name: 'Refresh offers' }).click();
  await page.getByRole('button', { name: 'Review authorization' }).click();
  const m = page.getByRole('dialog');
  await expect(m).toContainText('USD 22.50');
  await m.getByRole('checkbox').check();
  await m
    .getByRole('button', { name: 'Confirm merchant authorization' })
    .click();
  await expect(page.getByTestId('settlement-status')).toContainText(
    'Mock refund verified',
    { timeout: 25000 },
  );
  await customer.reload();
  await expect(customer.getByTestId('settlement-status')).toContainText(
    'Mock refund verified',
  );
  const cap = await migration.capture.findUniqueOrThrow({
    where: { id: f.captureId },
  });
  expect(cap.refundedMinor).toBe(2250n);
  expect(cap.reservedMinor).toBe(0n);
  await context.close();
});
test('merchant assistance fails safely without consented reviewed analysis and never sends an offer', async ({
  page,
}) => {
  const other = await createSettlementFixture(migration, password);
  await login(
    page,
    other.ownerEmail,
    `/merchant/${other.merchantId}/cases/${other.caseId}`,
  );
  await page
    .getByRole('button', { name: 'Use reviewed AI suggestion' })
    .click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /Request failed|Resource not found|No validated/ }),
  ).toBeVisible();
  expect(
    await migration.proposal.count({ where: { caseId: other.caseId } }),
  ).toBe(0);
});

test('synthetic purchase to complaint, exact local consent, mock analysis and merchant review', async ({
  page,
  browser,
}) => {
  test.setTimeout(90000);
  const demo = await createHackathonFixture(
    migration,
    env.DATABASE_URL,
    key,
    password,
    true,
  );
  await intercept(page);
  await page.goto('/complaints/new?orderId=' + demo.purchaseOrderId);
  await page.getByLabel('Email', { exact: true }).fill(demo.customerEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Category', { exact: true }).selectOption('DAMAGED');
  await page
    .getByLabel('Title', { exact: true })
    .fill('Synthetic damaged parcel');
  await page
    .getByLabel('Description', { exact: true })
    .fill(
      'SYNTHETIC ONLY: the demonstration parcel arrived damaged and requires merchant review.',
    );
  await page
    .getByLabel('Desired outcome', { exact: true })
    .selectOption('PARTIAL_REFUND');
  await page
    .getByRole('button', { name: 'Submit complaint', exact: true })
    .click();
  await expect(page).toHaveURL(/complaints\/[0-9a-f-]+$/);
  const caseId = page.url().split('/').pop()!;
  await page
    .getByRole('button', { name: 'Prepare sharing preview', exact: true })
    .click();
  const evidenceDb = new PaymentDatabase(process.env.EVIDENCE_DATABASE_URL!),
    inferDb = new PaymentDatabase(process.env.AI_DATABASE_URL!);
  try {
    await expect
      .poll(async () => migration.aIContext.count({ where: { caseId } }))
      .toBe(1);
    const context = await migration.aIContext.findFirstOrThrow({
      where: { caseId },
    });
    await new ContextPreparer(
      evidenceDb,
      new PrivateStorage(storageEnvSchema.parse(process.env)),
      key,
    ).process(demo.merchantId, context.id);
    await page
      .getByRole('checkbox', { name: /exact local-only mock/ })
      .check({ timeout: 20000 });
    await page
      .getByRole('button', { name: 'Consent to this preview', exact: true })
      .click();
    await expect(
      page.getByText('Consent recorded.', { exact: false }),
    ).toBeVisible();
    const ctx = await browser.newContext(),
      merchant = await ctx.newPage();
    await login(
      merchant,
      demo.ownerEmail,
      '/merchant/' + demo.merchantId + '/cases/' + caseId,
    );
    await merchant
      .getByRole('button', { name: 'Request AI analysis', exact: true })
      .click();
    await expect
      .poll(async () => migration.analysis.count({ where: { caseId } }))
      .toBe(1);
    const run = await migration.analysis.findFirstOrThrow({
      where: { caseId },
    });
    await new AnalysisEngine(inferDb, new MockAIProvider(), key).run(
      demo.merchantId,
      run.id,
    );
    await merchant
      .getByLabel('Review reason', { exact: true })
      .fill(
        'Reviewed synthetic allegations and deterministic policy constraints.',
      );
    await merchant
      .getByRole('button', {
        name: 'Approve internal recommendation',
        exact: true,
      })
      .click({ timeout: 20000 });
    await expect
      .poll(async () =>
        migration.aIReview.count({ where: { analysisId: run.id } }),
      )
      .toBe(1);
    await merchant
      .getByRole('button', { name: 'Use reviewed AI suggestion', exact: true })
      .click();
    await merchant
      .getByLabel('Customer-visible terms')
      .fill(
        'Synthetic partial refund for the damaged demo parcel; no real funds move.',
      );
    await merchant
      .getByRole('button', { name: 'Save private draft', exact: true })
      .click();
    await merchant
      .getByRole('button', { name: 'Publish offer #1', exact: true })
      .click();
    await expect(
      merchant.getByRole('button', { name: 'Publish offer #1', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Refresh offers', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review acceptance', exact: true })
      .click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').check();
    await dialog
      .getByRole('button', { name: 'Confirm customer acceptance', exact: true })
      .click();
    await expect(page.getByTestId('settlement-status')).toContainText(
      'Awaiting separate merchant authorization',
    );
    await merchant
      .getByRole('button', { name: 'Refresh offers', exact: true })
      .click();
    await merchant
      .getByRole('button', { name: 'Review authorization', exact: true })
      .click();
    dialog = merchant.getByRole('dialog');
    await dialog.getByRole('checkbox').check();
    await dialog
      .getByRole('button', {
        name: 'Confirm merchant authorization',
        exact: true,
      })
      .click();
    await expect(merchant.getByTestId('settlement-status')).toContainText(
      'Mock refund verified',
      { timeout: 25000 },
    );
    await merchant.goto('/merchant/' + demo.merchantId + '/cases');
    await expect(
      merchant
        .getByTestId('merchant-case-grid')
        .getByText('Stale - reanalyse', { exact: true }),
    ).toBeVisible();
    await merchant.goto('/merchant/' + demo.merchantId + '/analytics');
    await expect(
      merchant.getByRole('heading', { name: 'Resolution analytics' }),
    ).toBeVisible();
    await expect(
      merchant.getByText('Local mock', { exact: false }).first(),
    ).toBeVisible();
    await merchant.setViewportSize({ width: 390, height: 844 });
    expect(
      await merchant.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await ctx.close();
  } finally {
    await evidenceDb.close();
    await inferDb.close();
  }
});

test('merchant Community grid uses real scoped cases, filtering, sorting, navigation and retry', async ({
  page,
}) => {
  const inbox = await createSettlementFixture(migration, password);
  await intercept(page);
  let fail = true;
  await page.route(
    '**/api/v1/merchants/' + inbox.merchantId + '/cases?**',
    async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'Temporary case inbox unavailability',
          }),
        });
      } else await route.fallback();
    },
  );
  await page.goto('/merchant/' + inbox.merchantId + '/cases');
  await page.getByLabel('Email', { exact: true }).fill(inbox.ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary case inbox');
  fail = false;
  await page.getByRole('button', { name: 'Retry case inbox' }).click();
  const grid = page.getByTestId('merchant-case-grid');
  await expect(
    grid.getByRole('link', { name: 'Synthetic damaged demonstration item' }),
  ).toBeVisible();
  await expect(grid.getByText('No analysis', { exact: true })).toBeVisible();
  const header = grid.getByRole('columnheader', {
    name: 'Complaint',
    exact: true,
  });
  await header.locator('.ag-header-cell-text').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  const filter = grid.locator('.ag-floating-filter[col-id="title"] input');
  await filter.fill('does not exist in this tenant');
  await expect(
    grid.getByText('No matching complaints in this server page.'),
  ).toBeVisible();
  await filter.fill('Synthetic');
  await expect(
    grid.getByRole('link', { name: 'Synthetic damaged demonstration item' }),
  ).toBeVisible();
  await expect(grid.locator('.ag-paging-panel')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await grid.locator('.ag-row[row-index="0"] [col-id="status"]').click();
  await expect(page).toHaveURL(
    '/merchant/' + inbox.merchantId + '/cases/' + inbox.caseId,
  );
  await expect(
    page.getByRole('heading', { name: 'Negotiation & settlement' }),
  ).toBeVisible();
});

test('merchant inbox denies another tenant through its real cases API', async ({
  page,
}) => {
  const own = await createSettlementFixture(migration, password);
  await intercept(page);
  await page.goto('/merchant/' + f.merchantId + '/cases');
  await page.getByLabel('Email', { exact: true }).fill(own.ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    /not found|NOT FOUND|Resource/i,
  );
  await expect(page.getByTestId('merchant-case-grid')).toHaveCount(0);
});
