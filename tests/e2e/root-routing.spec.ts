import { test, expect, type Page } from '@playwright/test';
const tenant = '10000000-0000-4000-8000-000000000071',
  other = '10000000-0000-4000-8000-000000000072';
const session = (memberships: { merchantId: string; role: string }[] = []) => ({
  user: {
    id: '20000000-0000-4000-8000-000000000071',
    email: 'synthetic-root@resolveai.test',
  },
  csrfToken: 'synthetic-csrf',
  memberships,
});
async function mock(
  page: Page,
  answer: () => { status: number; data: unknown },
  gate?: Promise<void>,
) {
  let requests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/session')) {
      requests++;
      if (gate) await gate;
      const result = answer();
      return route.fulfill({
        status: result.status,
        contentType: 'application/json',
        body: JSON.stringify({ data: result.data }),
      });
    }
    if (route.request().method() !== 'GET')
      throw Error('Database mutation forbidden');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], page: { nextCursor: null } }),
    });
  });
  return () => requests;
}
test('root sends signed-out users to role login without redirect loops', async ({
  page,
}) => {
  const calls = await mock(page, () => ({ status: 401, data: null }));
  await page.goto('/status');
  await page.goto('/');
  await expect(page).toHaveURL('/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in to ResolveAI' }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/status');
  expect(calls()).toBeLessThan(6);
});
test('root sends an authenticated customer to orders without login flashing', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await mock(page, () => ({ status: 200, data: session() }), gate);
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Checking your session...');
  await expect(page).toHaveURL('/');
  await expect(
    page.getByRole('heading', { name: 'Sign in to ResolveAI' }),
  ).toHaveCount(0);
  release();
  await expect(page).toHaveURL('/orders');
  await expect(page.getByRole('heading', { name: 'My Orders' })).toBeVisible();
});
for (const role of ['OWNER', 'APPROVER', 'AGENT'])
  test(
    'root routes verified merchant ' + role + ' to the returned tenant',
    async ({ page }) => {
      await mock(page, () => ({
        status: 200,
        data: session([{ merchantId: tenant, role }]),
      }));
      await page.goto('/');
      await expect(page).toHaveURL('/merchant/' + tenant + '/cases');
      await expect(
        page.getByRole('heading', { name: 'Sign in to ResolveAI' }),
      ).toHaveCount(0);
    },
  );
test('root asks a multi-tenant merchant to choose an authorized workspace', async ({
  page,
}) => {
  await mock(page, () => ({
    status: 200,
    data: session([
      { merchantId: tenant, role: 'OWNER' },
      { merchantId: other, role: 'AGENT' },
    ]),
  }));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Choose your merchant workspace' }),
  ).toBeVisible();
  await expect(page).toHaveURL('/');
  await page.getByLabel('Merchant workspace').selectOption(other);
  await expect(page).toHaveURL('/merchant/' + other + '/cases');
});
for (const code of [429, 503])
  test(
    'root preserves its session gate on ' + code + ' and allows recovery',
    async ({ page }) => {
      let status = code;
      await mock(page, () => ({ status, data: session() }));
      await page.goto('/');
      await expect(page.getByRole('alert')).toContainText(
        'could not be verified',
      );
      await expect(page).toHaveURL('/');
      await expect(
        page.getByRole('heading', { name: 'Sign in to ResolveAI' }),
      ).toHaveCount(0);
      status = 200;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page).toHaveURL('/orders');
    },
  );
test('root fails closed for a malformed backend membership', async ({
  page,
}) => {
  await mock(page, () => ({
    status: 200,
    data: session([{ merchantId: tenant, role: 'SUPERADMIN' }]),
  }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page).toHaveURL('/');
});
