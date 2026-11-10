import { describe, it, expect } from 'vitest';
import {
  createPayPalClient,
  PayPalError,
  type PayPalTransport,
} from './index.js';
const config = {
  environment: 'sandbox',
  clientId: 'public-test-client',
  clientSecret: 'synthetic-secret-only',
  merchantId: 'SELLERTEST',
};
const key = '50000000-0000-4000-8000-000000000001';
const order = {
  id: 'PPORDER1',
  status: 'CREATED',
  intent: 'CAPTURE',
  purchase_units: [
    {
      reference_id: 'internal',
      custom_id: 'internal',
      amount: { value: '100.00', currency_code: 'USD' },
      payee: { merchant_id: 'SELLERTEST' },
    },
  ],
};
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const token = () =>
  response({ access_token: 'synthetic-token', expires_in: 100 });
describe('Sandbox provider client', () => {
  it('single-flights OAuth and refreshes before expiration', async () => {
    let oauth = 0,
      clock = 0;
    const transport: PayPalTransport = async (url) => {
      if (url.endsWith('/token')) {
        oauth++;
        return token();
      }
      return response(order);
    };
    const client = createPayPalClient(config, transport, () => clock);
    await Promise.all([
      client.getOrder('PPORDER1'),
      client.getOrder('PPORDER1'),
    ]);
    expect(oauth).toBe(1);
    clock = 91000;
    await client.getOrder('PPORDER1');
    expect(oauth).toBe(2);
  });
  it('uses form-encoded client credentials and keeps them in server authorization', async () => {
    let seen = false;
    const client = createPayPalClient(config, async (url, init) => {
      if (url.endsWith('/token')) {
        expect(init.body).toBe('grant_type=client_credentials');
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Basic ' +
            Buffer.from('public-test-client:synthetic-secret-only').toString(
              'base64',
            ),
        );
        seen = true;
        return token();
      }
      return response(order);
    });
    await client.getOrder('PPORDER1');
    expect(seen).toBe(true);
  });
  it('refreshes once on 401 while preserving capture key and body', async () => {
    let oauth = 0,
      posts = 0;
    const requests: RequestInit[] = [];
    const client = createPayPalClient(config, async (url, init) => {
      if (url.endsWith('/token')) {
        oauth++;
        return token();
      }
      requests.push(init);
      posts++;
      return posts === 1
        ? response({ name: 'AUTHENTICATION_FAILURE' }, 401)
        : response({ ...order, status: 'COMPLETED' });
    });
    await client.captureOrder('PPORDER1', key);
    expect(oauth).toBe(2);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(
        (request.headers as Record<string, string>)['PayPal-Request-Id'],
      ).toBe(key);
      expect(request.body).toBe('{}');
    }
  });
  it('creates an order with stable caller key and full response preference', async () => {
    let post: RequestInit | undefined;
    const client = createPayPalClient(config, async (url, init) => {
      if (url.endsWith('/token')) return token();
      post = init;
      return response(order, 201);
    });
    const payload = {
      intent: 'CAPTURE' as const,
      purchase_units: [
        {
          reference_id: 'internal',
          custom_id: 'internal',
          payee: { merchant_id: 'SELLERTEST' },
          amount: { value: '100.00', currency_code: 'USD' as const },
        },
      ],
    };
    expect((await client.createOrder(payload, key)).id).toBe('PPORDER1');
    expect(JSON.parse(post!.body as string)).toEqual(payload);
    expect((post!.headers as Record<string, string>).Prefer).toBe(
      'return=representation',
    );
  });
  it('normalizes a transient 503 without exposing response details', async () => {
    const client = createPayPalClient(config, async (url) =>
      url.endsWith('/token')
        ? token()
        : response(
            { name: 'INTERNAL_SERVER_ERROR', secret: 'do-not-leak' },
            503,
            { 'retry-after': '2', 'paypal-debug-id': 'DEBUG1' },
          ),
    );
    await expect(client.captureOrder('PPORDER1', key)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      uncertain: true,
      retryable: true,
      retryAfterMs: 2000,
      debugId: 'DEBUG1',
    });
  });
  it('classifies a dropped capture response as uncertain', async () => {
    const client = createPayPalClient(config, async (url) => {
      if (url.endsWith('/token')) return token();
      throw Error('Synthetic connection drop');
    });
    await expect(client.captureOrder('PPORDER1', key)).rejects.toMatchObject({
      code: 'TRANSPORT_UNCERTAIN',
      uncertain: true,
      retryable: true,
    });
  });
  it('normalizes definitive provider decline codes', async () => {
    const client = createPayPalClient(config, async (url) =>
      url.endsWith('/token')
        ? token()
        : response(
            {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'INSTRUMENT_DECLINED' }],
            },
            422,
          ),
    );
    await expect(client.captureOrder('PPORDER1', key)).rejects.toMatchObject({
      code: 'INSTRUMENT_DECLINED',
      uncertain: false,
      retryable: false,
    });
  });
  it('rejects invalid success bodies instead of accepting payment', async () => {
    const client = createPayPalClient(config, async (url) =>
      url.endsWith('/token') ? token() : response({ unexpected: 'value' }),
    );
    await expect(client.captureOrder('PPORDER1', key)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      uncertain: true,
    });
  });
  it('preserves original webhook-event formatting in the verification post', async () => {
    const raw = '{ "id": "WH1", "event_type": "PAYMENT.CAPTURE.COMPLETED" }';
    let submitted = '';
    const client = createPayPalClient(config, async (url, init) => {
      if (url.endsWith('/token')) return token();
      submitted = String(init.body);
      return response({ verification_status: 'SUCCESS' });
    });
    expect(
      await client.verifyWebhook(
        raw,
        {
          'paypal-transmission-id': 'T1',
          'paypal-transmission-time': '2026-11-09T00:00:00Z',
          'paypal-transmission-sig': 'signature',
          'paypal-cert-url':
            'https://api.sandbox.paypal.com/v1/notifications/certs/CERT1',
          'paypal-auth-algo': 'SHA256withRSA',
        },
        'WH-CONFIG',
      ),
    ).toBe(true);
    expect(submitted).toContain('"webhook_event":' + raw);
    expect(JSON.parse(submitted).webhook_id).toBe('WH-CONFIG');
  });
  it('rejects unsafe IDs without making requests and refuses live configuration', () => {
    const client = createPayPalClient(config, async () => token());
    expect(() => client.getCapture('../../evil')).toThrow(PayPalError);
    expect(() =>
      createPayPalClient({ ...config, environment: 'live' }),
    ).toThrow();
  });
});
