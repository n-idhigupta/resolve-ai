import { test, expect } from '@playwright/test';
const orderId = '60000000-0000-4000-8000-000000000001',
  operationId = '60000000-0000-4000-8000-000000000002',
  captureOperationId = '60000000-0000-4000-8000-000000000003';
for (const outcome of ['success', 'cancel', 'uncertain', 'sdk-error'] as const)
  test(
    'checkout browser workflow with mocked provider: ' + outcome,
    async ({ page }) => {
      let signedIn = false,
        state = 'NOT_STARTED',
        captures = 0,
        creates = 0;
      const money = { minor: '10000', currency: 'USD' };
      const session = {
        user: {
          id: '20000000-0000-4000-8000-000000000003',
          email: 'customer@resolveai.test',
        },
        csrfToken: 'synthetic-csrf',
      };
      await page.route(
        'https://www.sandbox.paypal.com/web-sdk/v6/core',
        (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `window.paypal={createInstance:async()=>({findEligibleMethods:async()=>({isEligible:()=>true}),createPayPalOneTimePaymentSession:(options)=>({hasReturned:()=>false,resume:async()=>{},start:async(_config,promise)=>{if(options.commit!==true)throw Error('Expected commit');const order=await promise;if('${outcome}'==='cancel')options.onCancel();else if('${outcome}'==='sdk-error')options.onError({code:'NETWORK_ERROR',debug_id:'safe123',message:'https://secret.test/?token=secret'});else await options.onApprove(order);}})})};`,
          }),
      );
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        const send = (data: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(
              status >= 400 ? data : { data, requestId: 'browser-fixture' },
            ),
          });
        if (path.endsWith('/auth/session'))
          return signedIn
            ? send(session)
            : send({ detail: 'Authentication required' }, 401);
        if (path.endsWith('/auth/login')) {
          signedIn = true;
          return send(session);
        }
        if (path === '/api/v1/orders')
          return send([
            {
              id: orderId,
              version: 0,
              status: 'UNPAID',
              paymentState: state,
              total: money,
            },
          ]);
        if (path.endsWith('/paypal/config'))
          return send({
            enabled: true,
            clientId: 'PUBLIC-TEST',
            environment: 'sandbox',
            currency: 'USD',
          });
        if (path.endsWith('/checkout')) {
          creates++;
          expect(request.postDataJSON()).toEqual({});
          expect(request.headers()['idempotency-key']).toBeTruthy();
          state = 'AWAITING_BUYER_APPROVAL';
          return send(
            {
              id: operationId,
              operationId,
              state: 'COMPLETED',
              providerOrderId: 'PPBROWSER1',
              errorCode: null,
            },
            202,
          );
        }
        if (path.endsWith('/capture')) {
          captures++;
          expect(request.postDataJSON()).toEqual({
            providerOrderId: 'PPBROWSER1',
          });
          state =
            outcome === 'uncertain' ? 'RECONCILIATION_REQUIRED' : 'CAPTURED';
          return send(
            {
              id: captureOperationId,
              state: outcome === 'uncertain' ? 'UNKNOWN' : 'COMPLETED',
              providerOrderId: 'PPBROWSER1',
              errorCode: null,
            },
            202,
          );
        }
        if (path.endsWith('/payments'))
          return send({
            orderId,
            status: state,
            version: 1,
            money,
            capture:
              state === 'CAPTURED'
                ? {
                    providerCaptureId: 'CAPBROWSER1',
                    grossMinor: '10000',
                    currency: 'USD',
                    completedAt: '2026-11-09T00:00:00Z',
                    verifiedAt: '2026-11-09T00:00:01Z',
                    providerStatus: 'COMPLETED',
                  }
                : null,
          });
        return send({ detail: 'Unexpected fixture request' }, 404);
      });
      await page.goto('/checkout');
      await page
        .getByLabel('Email', { exact: true })
        .fill('customer@resolveai.test');
      await page
        .getByLabel('Password', { exact: true })
        .fill('synthetic-development-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const pay = page.getByRole('button', { name: 'Pay with PayPal Sandbox' });
      await expect(pay).toBeEnabled();
      await pay.click();
      if (outcome === 'success') {
        await expect(page.getByTestId('payment-state')).toHaveText('CAPTURED');
        await expect(
          page.getByText('CAPBROWSER1', { exact: true }),
        ).toBeVisible();
        await expect(pay).toBeDisabled();
        expect(captures).toBe(1);
        await page.reload();
        await expect(page.getByTestId('payment-state')).toHaveText('CAPTURED');
        await expect(
          page.getByText('CAPBROWSER1', { exact: true }),
        ).toBeVisible();
        await expect(pay).toBeDisabled();
        expect(captures).toBe(1);
      }
      if (outcome === 'cancel') {
        await expect(page.getByRole('status')).toContainText(
          'approval window closed',
        );
        expect(captures).toBe(0);
        await expect(pay).toBeEnabled();
      }
      if (outcome === 'sdk-error') {
        await expect(page.getByRole('status')).toContainText(
          'checkout did not finish',
        );
        const diagnostic = await page.evaluate(() =>
          sessionStorage.getItem('resolveai.paypal.lastError'),
        );
        expect(diagnostic).toContain('safe123');
        expect(diagnostic).not.toContain('secret');
        expect(captures).toBe(0);
      }
      if (outcome === 'uncertain') {
        await expect(page.getByTestId('payment-state')).toHaveText(
          'RECONCILIATION REQUIRED',
        );
        await expect(
          page.getByText('Do not start another payment.', { exact: false }),
        ).toBeVisible();
        await expect(pay).toBeDisabled();
      }
      expect(creates).toBe(1);
    },
  );
