import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import {
  PaymentDatabase,
  PaymentStore,
  PaymentEngine,
  PaymentDelivery,
  RefundEngine,
  mockRefundProvider,
  type RefundFactory,
  type ProviderFactory,
  type PaymentJob,
} from '@resolveai/payment-store';
import { createPayPalClient } from '@resolveai/paypal-client';
import { connection, jobDefaults } from './queue.js';
export const paymentEnvSchema = z.object({
  WORKER_DATABASE_URL: z.url(),
  PAYPAL_ENVIRONMENT: z.literal('sandbox').default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_MERCHANT_ID: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().regex(/^[a-zA-Z0-9]{1,50}$/),
  WEBHOOK_PAYLOAD_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function startPaymentWorker(options: {
  redisUrl: string;
  store: PaymentStore;
  provider: ProviderFactory;
  encryptionKey: string;
  refundProvider?: RefundFactory;
  prefix?: string;
  intervalMs?: number;
}) {
  await options.store.db.assertWorker();
  const prefix = options.prefix ?? 'resolveai',
    producer = connection(options.redisUrl),
    consumer = connection(options.redisUrl);
  const queue = new Queue<PaymentJob>('payments-v1', {
    connection: producer,
    prefix,
    defaultJobOptions: jobDefaults,
  });
  const engine = new PaymentEngine(options.store, options.provider);
  const delivery = new PaymentDelivery(
    options.store,
    engine,
    (data, id) => queue.add('payment.process', data, { jobId: id }),
    options.encryptionKey,
    options.refundProvider
      ? new RefundEngine(options.store.db, options.refundProvider)
      : undefined,
  );
  const worker = new Worker(
    'payments-v1',
    (job) => delivery.process(job.data),
    { connection: consumer, prefix, concurrency: 2, maxStalledCount: 1 },
  );
  worker.on('error', () => console.error('Payment worker connection error'));
  worker.on('failed', (job) =>
    console.warn(
      'Payment job failed; durable sweeper retains recovery responsibility',
      job?.id,
    ),
  );
  await worker.waitUntilReady();
  let running: Promise<void> | undefined,
    stopping = false;
  const tick = () => {
    if (!running && !stopping) {
      running = delivery
        .tick()
        .catch(() => {
          console.error(
            'Payment delivery tick failed; persisted work remains pending',
          );
        })
        .finally(() => {
          running = undefined;
        });
    }
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 2000);
  return {
    queue,
    worker,
    delivery,
    close: async () => {
      stopping = true;
      clearInterval(timer);
      await running;
      await worker.close();
      await queue.close();
      await Promise.allSettled([producer.quit(), consumer.quit()]);
    },
  };
}
export async function startConfiguredPayments(redisUrl: string) {
  if (process.env.NODE_ENV === 'production')
    throw Error('SANDBOX_WORKER_FORBIDDEN_IN_PRODUCTION');
  const env = paymentEnvSchema.parse(process.env),
    db = new PaymentDatabase(env.WORKER_DATABASE_URL),
    store = new PaymentStore(db);
  const client = createPayPalClient({
    environment: env.PAYPAL_ENVIRONMENT,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    merchantId: env.PAYPAL_MERCHANT_ID,
    refundsEnabled: process.env.PAYPAL_REFUNDS_ENABLED === 'true',
  });
  try {
    const runtime = await startPaymentWorker({
      redisUrl,
      store,
      provider: (account) => {
        if (
          account.providerMerchantId !== env.PAYPAL_MERCHANT_ID ||
          account.webhookId !== env.PAYPAL_WEBHOOK_ID
        )
          throw Error(
            'Assigned account does not match configured Sandbox credentials',
          );
        return client;
      },
      refundProvider: (account) => {
        if (account.refundMode === 'mock')
          return mockRefundProvider(db, account);
        if (account.providerMerchantId !== env.PAYPAL_MERCHANT_ID)
          throw Error('Refund account mismatch');
        return client;
      },
      encryptionKey: env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY,
    });
    return {
      close: async () => {
        await runtime.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
