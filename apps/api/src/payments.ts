import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PaymentStore,
  PaymentError,
  operationDto,
} from '@resolveai/payment-store';
import type { WebhookHeaders } from '@resolveai/paypal-client';
import type { Database } from './database.js';
import { withActorTransaction, withTenantTransaction } from './database.js';
import { requireSession, checkCsrf } from './auth.js';
import type { Env } from './config.js';
import { AppError } from './errors.js';
export async function registerPayments(
  app: FastifyInstance,
  db: Database,
  store: PaymentStore,
  env: Env,
) {
  const requireEnabled = () => {
    if (env.PAYPAL_ENABLED !== 'true')
      throw new PaymentError(
        503,
        'PAYPAL_DISABLED',
        'Sandbox checkout is not configured',
      );
  };
  async function ownedOrder(request: FastifyRequest) {
    const auth = await requireSession(request, db, env);
    const { orderId } = z
      .strictObject({ orderId: z.uuid() })
      .parse(request.params);
    const ownership = await withActorTransaction(db, auth.user.id, (tx) =>
      tx.customerOrder.findFirst({ where: { orderId, userId: auth.user.id } }),
    );
    if (!ownership) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    return { ...auth, orderId, merchantId: ownership.merchantId };
  }
  app.get('/api/v1/paypal/config', async (request) => {
    await requireSession(request, db, env);
    return {
      data: {
        enabled: env.PAYPAL_ENABLED === 'true',
        environment: 'sandbox',
        clientId: env.PAYPAL_CLIENT_ID ?? null,
        currency: 'USD',
        sdkUrl: 'https://www.sandbox.paypal.com/web-sdk/v6/core',
      },
      requestId: request.id,
    };
  });
  for (const kind of ['checkout', 'capture'] as const)
    app.post('/api/v1/orders/:orderId/' + kind, async (request, reply) => {
      const context = await ownedOrder(request);
      checkCsrf(request, context.session.tokenHash, env);
      requireEnabled();
      const body =
        kind === 'checkout'
          ? z.strictObject({}).parse(request.body)
          : z
              .strictObject({
                providerOrderId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
              })
              .parse(request.body);
      const key = z
        .string()
        .min(1)
        .max(128)
        .parse(request.headers['idempotency-key']);
      const match = request.headers['if-match'];
      if (typeof match !== 'string' || !/^"?\d+"?$/.test(match))
        throw new AppError(
          428,
          'VERSION_REQUIRED',
          'If-Match order version is required',
        );
      const version = Number(match.replaceAll('"', ''));
      if (!Number.isSafeInteger(version))
        throw new AppError(422, 'INVALID_VERSION', 'Invalid order version');
      const op = await store.requestIntent(
        {
          merchantId: context.merchantId,
          orderId: context.orderId,
          userId: context.user.id,
          key,
          version,
          ...('providerOrderId' in body
            ? { providerOrderId: body.providerOrderId }
            : {}),
        },
        kind === 'checkout' ? 'CREATE' : 'CAPTURE',
      );
      return reply
        .status(202)
        .send({ data: operationDto(op), requestId: request.id });
    });
  app.get('/api/v1/orders/:orderId/payments', async (request) => {
    const auth = await requireSession(request, db, env);
    const { orderId } = z
      .strictObject({ orderId: z.uuid() })
      .parse(request.params);
    const candidates = await withActorTransaction(
      db,
      auth.user.id,
      async (tx) => {
        const owned = await tx.customerOrder.findMany({
          where: { userId: auth.user.id, orderId },
          select: { merchantId: true },
        });
        const member = await tx.membership.findMany({
          where: { userId: auth.user.id, active: true },
          select: { merchantId: true },
        });
        return [...new Set([...owned, ...member].map((x) => x.merchantId))];
      },
    );
    for (const merchantId of candidates) {
      const row = await withTenantTransaction(
        db,
        { userId: auth.user.id },
        merchantId,
        (tx) => tx.order.findFirst({ where: { id: orderId, merchantId } }),
      );
      if (row)
        return {
          data: await store.payment(merchantId, auth.user.id, orderId),
          requestId: request.id,
        };
    }
    throw new AppError(404, 'NOT_FOUND', 'Order not found');
  });
  app.get('/api/v1/payment-operations/:operationId', async (request) => {
    const { user } = await requireSession(request, db, env);
    const { operationId } = z
      .strictObject({ operationId: z.uuid() })
      .parse(request.params);
    const candidates = await withActorTransaction(db, user.id, async (tx) => {
      const own = await tx.customerOrder.findMany({
        where: { userId: user.id },
        select: { merchantId: true },
      });
      const membership = await tx.membership.findMany({
        where: { userId: user.id, active: true },
        select: { merchantId: true },
      });
      return [...new Set([...own, ...membership].map((x) => x.merchantId))];
    });
    for (const merchantId of candidates) {
      const op = await withTenantTransaction(
        db,
        { userId: user.id },
        merchantId,
        (tx) =>
          tx.checkoutOperation.findFirst({
            where: { merchantId, id: operationId },
          }),
      );
      if (op)
        return {
          data: operationDto(
            op as unknown as Parameters<typeof operationDto>[0],
          ),
          requestId: request.id,
        };
    }
    throw new AppError(404, 'NOT_FOUND', 'Operation not found');
  });
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 262144 },
      (_request, body, done) => done(null, body),
    );
    webhook.post(
      '/api/v1/webhooks/paypal/:accountKey',
      {
        bodyLimit: 262144,
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      },
      async (request, reply) => {
        requireEnabled();
        const { accountKey } = z
          .strictObject({ accountKey: z.string().min(1).max(100) })
          .parse(request.params);
        if (!Buffer.isBuffer(request.body))
          throw new AppError(400, 'INVALID_WEBHOOK', 'Expected JSON body');
        const raw = request.body.toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new AppError(400, 'INVALID_WEBHOOK', 'Malformed JSON');
        }
        const event = z
          .object({
            id: z.string().min(1).max(128),
            event_type: z.string().min(1).max(100),
          })
          .parse(parsed);
        const headers = {} as WebhookHeaders;
        for (const name of [
          'paypal-transmission-id',
          'paypal-transmission-time',
          'paypal-transmission-sig',
          'paypal-cert-url',
          'paypal-auth-algo',
        ] as const)
          headers[name] = z
            .string()
            .min(1)
            .max(2048)
            .parse(request.headers[name]);
        const cert = new URL(headers['paypal-cert-url']);
        if (
          cert.protocol !== 'https:' ||
          !['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(
            cert.hostname,
          ) ||
          !cert.pathname.startsWith('/v1/notifications/certs/')
        )
          throw new AppError(
            400,
            'INVALID_WEBHOOK',
            'Unexpected PayPal certificate URL',
          );
        const rows = await store.receipt(
          accountKey,
          event.id,
          raw,
          headers,
          env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY!,
        );
        if (!rows.length)
          throw new AppError(404, 'NOT_FOUND', 'Webhook account not found');
        return reply
          .status(202)
          .send({ data: { received: true }, requestId: request.id });
      },
    );
  });
}
