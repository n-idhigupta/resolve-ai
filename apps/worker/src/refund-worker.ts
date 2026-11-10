import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import {
  RefundEngine,
  RefundDelivery,
  mockRefundProvider,
  PaymentDatabase,
  type RefundFactory,
} from '@resolveai/payment-store';
import { connection, jobDefaults } from './queue.js';
const job = z.strictObject({ merchantId: z.uuid(), id: z.uuid() });
export async function startMockRefundWorker(
  redisUrl: string,
  db: PaymentDatabase,
  options: {
    prefix?: string;
    intervalMs?: number;
    provider?: RefundFactory;
  } = {},
) {
  if (process.env.NODE_ENV === 'production')
    throw Error('MOCK_REFUNDS_FORBIDDEN_IN_PRODUCTION');
  await db.assertWorker();
  const producer = connection(redisUrl),
    consumer = connection(redisUrl),
    prefix = options.prefix ?? 'resolveai';
  const queue = new Queue('refunds-v1', {
    connection: producer,
    prefix,
    defaultJobOptions: jobDefaults,
  });
  const engine = new RefundEngine(
    db,
    options.provider ?? ((a) => mockRefundProvider(db, a)),
    ['mock'],
  );
  const delivery = new RefundDelivery(engine, (merchantId, id, jobId) =>
    queue.add('refund.process', { merchantId, id }, { jobId }),
  );
  const worker = new Worker(
    'refunds-v1',
    async (j) => {
      const p = job.parse(j.data);
      await engine.run(p.merchantId, p.id);
    },
    { connection: consumer, prefix, concurrency: 2, maxStalledCount: 1 },
  );
  worker.on('error', () =>
    console.error('Mock refund worker connection error'),
  );
  worker.on('failed', (j) =>
    console.warn('Mock refund job failed; durable recovery retained', j?.id),
  );
  await worker.waitUntilReady();
  let pending: Promise<void> | undefined,
    stopping = false;
  const tick = () => {
    if (!pending && !stopping)
      pending = delivery
        .tick()
        .catch(() =>
          console.error('Mock refund sweep failed; work remains durable'),
        )
        .finally(() => {
          pending = undefined;
        });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 2000);
  return {
    engine,
    delivery,
    queue,
    close: async () => {
      stopping = true;
      clearInterval(timer);
      await pending;
      await worker.close();
      await queue.close();
      await Promise.allSettled([producer.quit(), consumer.quit()]);
    },
  };
}
