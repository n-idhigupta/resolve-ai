import pino from 'pino';
import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { PaymentDatabase } from '@resolveai/payment-store';
import {
  EvidenceProcessor,
  PrivateStorage,
  storageEnvSchema,
} from '@resolveai/case-store';
import { connection, jobDefaults } from './queue.js';
export async function startEvidenceWorker(
  redisUrl: string,
  databaseUrl: string,
  prefix = 'resolveai',
) {
  const log = pino({
    name: 'evidence-worker',
    level: process.env.LOG_LEVEL ?? 'info',
  });
  const db = new PaymentDatabase(databaseUrl),
    storage = new PrivateStorage(storageEnvSchema.parse(process.env)),
    processor = new EvidenceProcessor(db, storage);
  await processor.assertSafe();
  const producer = connection(redisUrl),
    consumer = connection(redisUrl),
    queue = new Queue('evidence-v1', {
      connection: producer,
      prefix,
      defaultJobOptions: jobDefaults,
    });
  const jobSchema = z.strictObject({ merchantId: z.uuid(), id: z.uuid() });
  const worker = new Worker(
    'evidence-v1',
    async (job) => {
      const d = jobSchema.parse(job.data);
      await processor.process(d.merchantId, d.id);
    },
    { connection: consumer, prefix, concurrency: 1 },
  );
  worker.on('error', () => log.error('Evidence worker connection failed'));
  worker.on('failed', (job) =>
    log.warn({ jobId: job?.id }, 'Evidence job failed; durable work retained'),
  );
  await worker.waitUntilReady();
  let active: Promise<void> | undefined,
    stopped = false;
  const tick = async () => {
    for (const { merchantId } of await processor.tenants()) {
      const events = await db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'UPDATE "OutboxEvent" SET "leaseOwner"=gen_random_uuid(),"leaseUntil"=now()+interval \'30 seconds\',attempts=attempts+1 WHERE id IN (SELECT id FROM "OutboxEvent" WHERE "eventType"=\'evidence.validate\' AND "deliveredAt" IS NULL AND "availableAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) FOR UPDATE SKIP LOCKED LIMIT 25) RETURNING *',
            )
          ).rows,
      );
      for (const e of events) {
        await queue.add(
          'validate',
          { merchantId, id: e.aggregateId },
          { jobId: 'outbox-' + e.id + '-' + e.attempts },
        );
        await db.transaction(merchantId, null, (tx) =>
          tx.query(
            'UPDATE "OutboxEvent" SET "deliveredAt"=now(),"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
            [e.id, e.leaseOwner],
          ),
        );
      }
      const rows = await db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'SELECT id FROM "Evidence" WHERE "uploadState" IN (\'QUEUED\',\'PROCESSING\') AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=now()) LIMIT 25',
            )
          ).rows,
      );
      for (const r of rows)
        await queue.add(
          'validate',
          { merchantId, id: r.id },
          { jobId: 'recover-' + r.id + '-' + Math.floor(Date.now() / 60000) },
        );
      await processor.cleanup(merchantId);
    }
  };
  const launch = () => {
    if (!stopped && !active)
      active = tick()
        .catch(() =>
          console.warn('Evidence sweep failed; durable work retained'),
        )
        .finally(() => {
          active = undefined;
        });
  };
  launch();
  const timer = setInterval(launch, 2000);
  return {
    processor,
    queue,
    worker,
    close: async () => {
      stopped = true;
      clearInterval(timer);
      await active;
      await worker.close();
      await queue.close();
      await Promise.allSettled([producer.quit(), consumer.quit()]);
      await db.close();
    },
  };
}
