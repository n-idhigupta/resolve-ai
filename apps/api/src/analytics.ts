import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AnalyticsStore } from '@resolveai/case-store';
import { PaymentDatabase } from '@resolveai/payment-store';
import { requireSession } from './auth.js';
import type { Database } from './database.js';
import type { Env } from './config.js';
export async function registerAnalytics(
  app: FastifyInstance,
  db: Database,
  storeDb: PaymentDatabase,
  env: Env,
) {
  const store = new AnalyticsStore(storeDb);
  app.get('/api/v1/merchants/:merchantId/analytics', async (r) => {
    const auth = await requireSession(r, db, env),
      p = z.strictObject({ merchantId: z.uuid() }).parse(r.params);
    return {
      data: await store.read(
        { merchantId: p.merchantId, userId: auth.user.id },
        r.query,
      ),
      requestId: r.id,
    };
  });
}
