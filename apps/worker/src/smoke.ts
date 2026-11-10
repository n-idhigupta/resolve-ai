import { randomUUID } from 'node:crypto';
import { workerEnvSchema } from './config.js';
import { createPingQueue, createPingEvents } from './queue.js';
const env = workerEnvSchema.parse(process.env),
  q = createPingQueue(env.REDIS_URL),
  e = createPingEvents(env.REDIS_URL);
try {
  await e.events.waitUntilReady();
  const requestId = randomUUID();
  const job = await q.queue.add(
    'foundation.ping',
    { schemaVersion: 1, requestId, message: 'Local foundation smoke test' },
    { jobId: requestId },
  );
  const result: unknown = await job.waitUntilFinished(e.events, 15000);
  console.log(JSON.stringify(result));
} finally {
  await Promise.all([q.close(), e.close()]);
}
