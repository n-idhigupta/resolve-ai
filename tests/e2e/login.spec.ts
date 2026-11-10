import { test, expect, type Page } from '@playwright/test';
const tenant = '10000000-0000-4000-8000-000000000091',
  other = '10000000-0000-4000-8000-000000000092';
async function mock(
  page: Page,
  memberships: { merchantId: string; role: string }[] = [],
  status = 200,
) {
  let signedIn = false;
  let loginBody: unknown;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const session = {
      user: {
        id: '20000000-0000-4000-8000-000000000091',
        email: 'synthetic@resolveai.test',
      },
      csrfToken: 'synthetic-csrf',
      memberships,
    };
    const send = (data: unknown, code = 200) =>
      route.fulfill({
        status: code,
        contentType: 'application/json',
        body: JSON.stringify(
          code >= 400
            ? { detail: 'Synthetic test rejection' }
            : { data, requestId: 'synthetic', page: { nextCursor: null } },
        ),
      });
    if (path.endsWith('/auth/session'))
      return signedIn ? send(session) : send({}, 401);
    if (path.endsWith('/auth/login')) {
      loginBody = route.request().postDataJSON();
      signedIn = status === 200;
      return send(session, status);
    }
    if (/\/(checkout|capture|authorize|refunds)(\/|$)/.test(path))
      throw Error('Financial request forbidden');
    return send([]);
  });
  return () => loginBody;
}
async function credentials(page: Page) {
  await page
    .getByLabel('Email', { exact: true })
    .fill('synthetic@resolveai.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('synthetic-browser-password-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('customer card signs in to customer dashboard and sends no role assertion', async ({
  page,
}) => {
  const body = await mock(page);
  await page.goto('/login');
  await expect(
    page.getByRole('button', { name: /Customer Track/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('form', { name: 'Customer login' }),
  ).toBeVisible();
  await credentials(page);
  await expect(page).toHaveURL('/orders');
  await expect(page.getByRole('heading', { name: 'My Orders' })).toBeVisible();
  expect(Object.keys(body() as object).sort()).toEqual(['email', 'password']);
});
test('merchant card routes an agent to its actual returned tenant, not requested tenant', async ({
  page,
}) => {
  await mock(page, [{ merchantId: tenant, role: 'AGENT' }]);
  await page.goto('/login');
  await page.getByRole('button', { name: /Merchant Review/ }).click();
  await expect(
    page.getByRole('form', { name: 'Merchant login' }),
  ).toBeVisible();
  await credentials(page);
  await expect(page).toHaveURL('/merchant/' + tenant + '/cases');
});
test('customer cannot gain merchant workspace by selecting the card', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/login');
  await page.getByRole('button', { name: /Merchant Review/ }).click();
  await credentials(page);
  await expect(page.getByRole('alert')).toContainText('no merchant workspace');
  await expect(page).toHaveURL('/login');
  await page.getByRole('button', { name: /Customer Track/ }).click();
  await expect(page.getByRole('alert')).toBeEmpty();
  await credentials(page);
  await expect(page).toHaveURL('/orders');
});
test('multiple merchant memberships require an explicit authorized workspace', async ({
  page,
}) => {
  await mock(page, [
    { merchantId: tenant, role: 'AGENT' },
    { merchantId: other, role: 'OWNER' },
  ]);
  await page.goto('/login');
  await page.getByRole('button', { name: /Merchant Review/ }).click();
  await credentials(page);
  await expect(
    page.getByRole('button', { name: 'Open workspace' }),
  ).toBeDisabled();
  await page.getByLabel('Merchant workspace').selectOption(other);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page).toHaveURL('/merchant/' + other + '/cases');
});
for (const status of [401, 429])
  test('login shows ' + status + ' without navigation', async ({ page }) => {
    await mock(page, [], status);
    await page.goto('/login');
    await credentials(page);
    await expect(page.getByRole('alert')).toContainText(
      status === 401
        ? 'Email or password is incorrect'
        : 'Too many sign-in attempts',
    );
    await expect(page).toHaveURL('/login');
  });
test('role selection is keyboard accessible and fits mobile', async ({
  page,
}) => {
  await mock(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  const merchant = page.getByRole('button', { name: /Merchant Review/ });
  await merchant.focus();
  await page.keyboard.press('Enter');
  await expect(merchant).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', { name: 'Merchant login' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
