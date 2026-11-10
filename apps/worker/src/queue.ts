import { Queue, Worker, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { pingJobSchema, type PingJob } from '@resolveai/shared';
export const queueName = 'foundation-ping';
export const jobDefaults = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: { age: 604800, count: 5000 },
};
export function connection(url: string) {
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
    retryStrategy: (n) => (n < 4 ? Math.min(n * 250, 1000) : null),
  });
  redis.on('error', () => {});
  return redis;
}
export function createPingQueue(url: string, prefix = 'resolveai') {
  const redis = connection(url);
  const queue = new Queue<PingJob>(queueName, {
    connection: redis,
    prefix,
    defaultJobOptions: jobDefaults,
  });
  return {
    queue,
    close: async () => {
      await queue.close();
      await redis.quit();
    },
  };
}
export function createPingWorker(
  url: string,
  prefix = 'resolveai',
  concurrency = 4,
) {
  const redis = connection(url),
    logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name !== 'foundation.ping') throw Error('Unknown foundation job');
      const data = pingJobSchema.parse(job.data);
      logger.info(
        {
          jobId: job.id,
          requestId: data.requestId,
          attempt: job.attemptsMade + 1,
        },
        'Harmless ping processed',
      );
      return { ok: true, requestId: data.requestId };
    },
    { connection: redis, prefix, concurrency, maxStalledCount: 1 },
  );
  worker.on('failed', (job) =>
    logger.warn(
      { jobId: job?.id, attempts: job?.attemptsMade },
      'Job attempt failed; exhausted jobs remain inspectable',
    ),
  );
  worker.on('error', () => logger.error('Worker connection error'));
  return {
    worker,
    close: async () => {
      await worker.close();
      await redis.quit();
    },
  };
}
export function createPingEvents(url: string, prefix = 'resolveai') {
  const redis = connection(url),
    events = new QueueEvents(queueName, { connection: redis, prefix });
  return {
    events,
    close: async () => {
      await events.close();
      await redis.quit();
    },
  };
}
