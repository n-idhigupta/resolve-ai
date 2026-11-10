import { test, expect } from '@playwright/test';
test('accessible foundation routing and actual readiness', async ({
  page,
  request,
}) => {
  expect((await request.get('http://localhost:3001/ready')).status()).toBe(200);
  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: 'Resolve complaints. Build trust.',
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Demo & Sandbox - Human-approved resolutions - Real refunds disabled',
    ),
  ).toBeVisible();
  await page.getByRole('link', { name: 'View system status' }).click();
  await expect(page).toHaveURL('/status');
  await expect(page.getByRole('status')).toHaveText(
    'API, database and Redis are ready.',
  );
  await page.getByRole('button', { name: 'Check again' }).focus();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeFocused();
});
test('renders API failure and allows retry', async ({ page }) => {
  await page.route('**/ready', (route) =>
    route.fulfill({ status: 503, body: '{}', contentType: 'application/json' }),
  );
  await page.goto('/status');
  await expect(page.getByRole('status')).toHaveText(
    'API dependencies are unavailable',
  );
  await page.unroute('**/ready');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'API, database and Redis are ready.',
  );
});
