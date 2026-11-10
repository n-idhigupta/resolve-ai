import { z } from 'zod';
export const paypalConfigSchema = z.strictObject({
  environment: z.literal('sandbox'),
  baseUrl: z
    .literal('https://api-m.sandbox.paypal.com')
    .default('https://api-m.sandbox.paypal.com'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  merchantId: z.string().min(1),
  refundsEnabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(30000).default(10000),
});
export type PayPalConfig = z.infer<typeof paypalConfigSchema>;
const amountSchema = z.object({
  value: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/),
  currency_code: z.string(),
});
export const captureSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  amount: amountSchema,
  final_capture: z.boolean().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  supplementary_data: z
    .object({ related_ids: z.object({ order_id: z.string().optional() }) })
    .optional(),
});
export type PayPalCapture = z.infer<typeof captureSchema>;
export const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  intent: z.string().optional(),
  purchase_units: z
    .array(
      z.object({
        reference_id: z.string().optional(),
        custom_id: z.string().optional(),
        amount: amountSchema,
        payee: z.object({ merchant_id: z.string().optional() }).optional(),
        payments: z
          .object({ captures: z.array(captureSchema).optional() })
          .optional(),
      }),
    )
    .optional(),
  links: z
    .array(
      z.object({
        href: z.string(),
        rel: z.string(),
        method: z.string().optional(),
      }),
    )
    .optional(),
});
export type PayPalOrder = z.infer<typeof orderSchema>;
export type CreateOrderRequest = {
  intent: 'CAPTURE';
  purchase_units: Array<{
    reference_id: string;
    custom_id: string;
    payee: { merchant_id: string };
    amount: { value: string; currency_code: 'USD' };
  }>;
};
export type WebhookHeaders = {
  'paypal-transmission-id': string;
  'paypal-transmission-time': string;
  'paypal-transmission-sig': string;
  'paypal-cert-url': string;
  'paypal-auth-algo': string;
};
export interface PayPalClient {
  createOrder(
    payload: CreateOrderRequest,
    requestId: string,
  ): Promise<PayPalOrder>;
  captureOrder(id: string, requestId: string): Promise<PayPalOrder>;
  getOrder(id: string): Promise<PayPalOrder>;
  getCapture(id: string): Promise<PayPalCapture>;
  verifyWebhook(
    raw: string,
    headers: WebhookHeaders,
    webhookId: string,
  ): Promise<boolean>;
}
export const refundRequestSchema = z.strictObject({
  amount: z.strictObject({
    value: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
    currency_code: z.literal('USD'),
  }),
  invoice_id: z.uuid(),
});
export type RefundRequest = z.infer<typeof refundRequestSchema>;
export const refundSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED']),
  amount: amountSchema,
  invoice_id: z.string().optional(),
  links: z
    .array(
      z.object({
        rel: z.string(),
        href: z.string(),
        method: z.string().optional(),
      }),
    )
    .optional(),
});
export type PayPalRefund = z.infer<typeof refundSchema>;
export interface RefundProvider {
  refundCapture(
    captureId: string,
    payload: RefundRequest,
    key: string,
  ): Promise<PayPalRefund>;
  getRefund(id: string): Promise<PayPalRefund>;
  getCapture(id: string): Promise<PayPalCapture>;
  getOrder(id: string): Promise<PayPalOrder>;
}
export class PayPalError extends Error {
  constructor(
    public code: string,
    public status: number,
    public uncertain: boolean,
    public retryable: boolean,
    public debugId: string | null = null,
    public retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}
export type PayPalTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
async function jsonBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 1048576)
    throw Error('Oversize provider response');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty provider response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1048576) {
      await reader.cancel();
      throw Error('Oversize provider response');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createPayPalClient(
  input: unknown,
  transport: PayPalTransport = (url, init) => fetch(url, init),
  now: () => number = Date.now,
): PayPalClient & RefundProvider {
  const config = paypalConfigSchema.parse(input);
  let cached: { value: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  async function token(): Promise<string> {
    if (cached && cached.expires > now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let response: Response;
      try {
        response = await transport(config.baseUrl + '/v1/oauth2/token', {
          method: 'POST',
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(config.clientId + ':' + config.clientSecret).toString(
                'base64',
              ),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new PayPalError('OAUTH_UNAVAILABLE', 0, false, true);
      }
      if (!response.ok)
        throw new PayPalError(
          'OAUTH_REJECTED',
          response.status,
          false,
          response.status === 429 || response.status >= 500,
        );
      let value;
      try {
        value = z
          .object({
            access_token: z.string().min(1),
            expires_in: z.number().positive(),
          })
          .parse(await jsonBody(response));
      } catch {
        throw new PayPalError('OAUTH_INVALID_RESPONSE', 0, false, true);
      }
      cached = {
        value: value.access_token,
        expires:
          now() +
          (value.expires_in - Math.min(60, value.expires_in / 10)) * 1000,
      };
      return cached.value;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    schema: z.ZodType<T>,
    body?: string,
    key?: string,
  ): Promise<T> {
    for (let refresh = 0; refresh < 2; refresh++) {
      const access = await token();
      let response: Response;
      try {
        response = await transport(config.baseUrl + path, {
          method,
          headers: {
            Authorization: 'Bearer ' + access,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            ...(key ? { 'PayPal-Request-Id': key } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(config.timeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new PayPalError(
          'TRANSPORT_UNCERTAIN',
          0,
          method === 'POST',
          true,
        );
      }
      if (response.status === 401 && refresh === 0) {
        cached = undefined;
        continue;
      }
      let data: unknown;
      try {
        data = await jsonBody(response);
      } catch {
        throw new PayPalError(
          'INVALID_PROVIDER_RESPONSE',
          response.status,
          method === 'POST',
          true,
        );
      }
      if (!response.ok) {
        const error = z
          .object({
            name: z.string().optional(),
            details: z
              .array(z.object({ issue: z.string().optional() }))
              .optional(),
          })
          .safeParse(data);
        const code = error.success
          ? (error.data.details?.[0]?.issue ??
            error.data.name ??
            'PROVIDER_ERROR')
          : 'PROVIDER_ERROR';
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new PayPalError(
          code,
          response.status,
          method === 'POST' &&
            (response.status >= 500 || response.status === 429),
          response.status === 429 || response.status >= 500,
          response.headers.get('paypal-debug-id'),
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : null,
        );
      }
      try {
        return schema.parse(data);
      } catch {
        throw new PayPalError(
          'INVALID_PROVIDER_RESPONSE',
          response.status,
          method === 'POST',
          false,
        );
      }
    }
    throw new PayPalError('AUTHENTICATION_FAILED', 401, false, false);
  }
  const id = (value: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
      throw new PayPalError('INVALID_PROVIDER_ID', 0, false, false);
    return encodeURIComponent(value);
  };
  return {
    createOrder: (payload, key) =>
      request(
        '/v2/checkout/orders',
        'POST',
        orderSchema,
        JSON.stringify(payload),
        z.uuid().parse(key),
      ),
    captureOrder: (value, key) =>
      request(
        `/v2/checkout/orders/${id(value)}/capture`,
        'POST',
        orderSchema,
        '{}',
        z.uuid().parse(key),
      ),
    getOrder: (value) =>
      request(`/v2/checkout/orders/${id(value)}`, 'GET', orderSchema),
    getCapture: (value) =>
      request(`/v2/payments/captures/${id(value)}`, 'GET', captureSchema),
    refundCapture: (captureId, payload, key) => {
      if (!config.refundsEnabled)
        throw new PayPalError('REFUNDS_DISABLED', 0, false, false);
      return request(
        '/v2/payments/captures/' + id(captureId) + '/refund',
        'POST',
        refundSchema,
        JSON.stringify(refundRequestSchema.parse(payload)),
        z.uuid().parse(key),
      );
    },
    getRefund: (value) =>
      request('/v2/payments/refunds/' + id(value), 'GET', refundSchema),
    verifyWebhook: async (raw, headers, webhookId) => {
      JSON.parse(raw);
      const metadata = {
        transmission_id: headers['paypal-transmission-id'],
        transmission_time: headers['paypal-transmission-time'],
        transmission_sig: headers['paypal-transmission-sig'],
        cert_url: headers['paypal-cert-url'],
        auth_algo: headers['paypal-auth-algo'],
        webhook_id: webhookId,
      };
      const body =
        JSON.stringify(metadata).slice(0, -1) + ',"webhook_event":' + raw + '}';
      const result = await request(
        '/v1/notifications/verify-webhook-signature',
        'POST',
        z.object({ verification_status: z.enum(['SUCCESS', 'FAILURE']) }),
        body,
      );
      return result.verification_status === 'SUCCESS';
    },
  };
}
