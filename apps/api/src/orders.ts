import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { idSchema, serializeMoney } from '@resolveai/shared';
import type { Database } from './database.js';
import { withActorTransaction, withTenantTransaction } from './database.js';
import { requireSession } from './auth.js';
import type { Env } from './config.js';
import { AppError } from './errors.js';
const paging = z.strictObject({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const dto = (row: {
  id: string;
  merchantId: string;
  status: string;
  version: number;
  amountMinor: bigint;
  currency: string;
  paymentState: string;
}) => ({
  id: row.id,
  merchantId: row.merchantId,
  status: row.status,
  paymentState: row.paymentState,
  version: row.version,
  total: serializeMoney(row.amountMinor, 'USD'),
});
export async function registerOrders(
  app: FastifyInstance,
  db: Database,
  env: Env,
) {
  app.get('/api/v1/orders', async (request) => {
    const { user } = await requireSession(request, db, env);
    const q = paging.parse(request.query);
    const ownerships = await withActorTransaction(db, user.id, (tx) =>
      tx.customerOrder.findMany({
        where: { userId: user.id },
        select: { merchantId: true },
      }),
    );
    const merchants = [...new Set(ownerships.map((x) => x.merchantId))];
    const sets = await Promise.all(
      merchants.map((merchantId) =>
        withTenantTransaction(db, { userId: user.id }, merchantId, (tx) =>
          tx.order.findMany({
            where: {
              merchantId,
              customerUserId: user.id,
              ...(q.cursor ? { id: { gt: q.cursor } } : {}),
            },
            orderBy: { id: 'asc' },
            take: q.limit + 1,
          }),
        ),
      ),
    );
    const rows = sets.flat().sort((a, b) => a.id.localeCompare(b.id));
    return {
      data: rows.slice(0, q.limit).map(dto),
      page: {
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      },
      requestId: request.id,
    };
  });
  app.get('/api/v1/orders/:orderId', async (request) => {
    const { user } = await requireSession(request, db, env);
    const { orderId } = z
      .strictObject({ orderId: idSchema })
      .parse(request.params);
    z.strictObject({}).parse(request.query);
    const candidates = await withActorTransaction(db, user.id, async (tx) => {
      const owned = await tx.customerOrder.findMany({
        where: { orderId, userId: user.id },
        select: { merchantId: true },
      });
      const member = await tx.membership.findMany({
        where: { userId: user.id, active: true },
        select: { merchantId: true },
      });
      return [...new Set([...owned, ...member].map((x) => x.merchantId))];
    });
    for (const merchantId of candidates) {
      const row = await withTenantTransaction(
        db,
        { userId: user.id },
        merchantId,
        (tx) => tx.order.findFirst({ where: { merchantId, id: orderId } }),
      );
      if (row) {
        const items = await withTenantTransaction(
          db,
          { userId: user.id },
          merchantId,
          (tx) => tx.orderItem.findMany({ where: { merchantId, orderId } }),
        );
        return {
          data: {
            ...dto(row),
            items: items.map((x) => ({
              description: x.description,
              quantity: x.quantity,
              unit: serializeMoney(x.unitMinor, 'USD'),
            })),
            paymentStatus: row.paymentState,
          },
          requestId: request.id,
        };
      }
    }
    throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  });
  app.get('/api/v1/merchants/:merchantId/orders', async (request) => {
    const { user } = await requireSession(request, db, env);
    const { merchantId } = z
      .strictObject({ merchantId: idSchema })
      .parse(request.params);
    const q = paging.parse(request.query);
    const rows = await withTenantTransaction(
      db,
      { userId: user.id },
      merchantId,
      (tx) =>
        tx.order.findMany({
          where: { merchantId, ...(q.cursor ? { id: { gt: q.cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: q.limit + 1,
        }),
      true,
    );
    return {
      data: rows.slice(0, q.limit).map(dto),
      page: {
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
      },
      requestId: request.id,
    };
  });
}
