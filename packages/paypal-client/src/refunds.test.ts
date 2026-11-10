import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPayPalClient, PayPalError } from './index.js';
const payload = () => ({
  amount: { value: '25.00', currency_code: 'USD' as const },
  invoice_id: randomUUID(),
});
it('blocks refund submission before OAuth when disabled', async () => {
  let calls = 0;
  const client = createPayPalClient(
    {
      environment: 'sandbox',
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      merchantId: 'SYNTHETIC',
    },
    async () => {
      calls++;
      throw Error('No network allowed');
    },
  );
  expect(() =>
    client.refundCapture('SYNTHETIC_CAPTURE', payload(), randomUUID()),
  ).toThrow('REFUNDS_DISABLED');
  expect(calls).toBe(0);
});
it('uses Payments v2 and stable request/body without hidden mutation retries', async () => {
  const requests: { url: string; init: RequestInit }[] = [],
    p = payload(),
    key = randomUUID();
  const client = createPayPalClient(
    {
      environment: 'sandbox',
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      merchantId: 'SYNTHETIC',
      refundsEnabled: true,
    },
    async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify(
          url.endsWith('token')
            ? { access_token: 'synthetic-token', expires_in: 3600 }
            : {
                id: 'SYNTHETIC_REFUND',
                status: 'COMPLETED',
                amount: p.amount,
                invoice_id: p.invoice_id,
              },
        ),
        { status: 200 },
      );
    },
  );
  await client.refundCapture('SYNTHETIC_CAPTURE', p, key);
  await client.getRefund('SYNTHETIC_REFUND');
  expect(
    requests[1]?.url.endsWith('/v2/payments/captures/SYNTHETIC_CAPTURE/refund'),
  ).toBe(true);
  expect(new Headers(requests[1]?.init.headers).get('PayPal-Request-Id')).toBe(
    key,
  );
  expect(JSON.parse(String(requests[1]?.init.body))).toEqual(p);
  expect(requests[2]?.init.method).toBe('GET');
});
it('marks a lost POST response uncertain without retrying the refund', async () => {
  let posts = 0;
  const client = createPayPalClient(
    {
      environment: 'sandbox',
      clientId: 'synthetic',
      clientSecret: 'synthetic',
      merchantId: 'SYNTHETIC',
      refundsEnabled: true,
    },
    async (url) => {
      if (url.endsWith('token'))
        return new Response(
          JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600 }),
        );
      posts++;
      throw Error('Simulated lost response');
    },
  );
  await expect(
    client.refundCapture('SYNTHETIC_CAPTURE', payload(), randomUUID()),
  ).rejects.toBeInstanceOf(PayPalError);
  expect(posts).toBe(1);
});
