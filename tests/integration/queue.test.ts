import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env } from './helpers.js';
import {
  createPingQueue,
  createPingWorker,
  createPingEvents,
} from '../../apps/worker/src/queue.js';
it('processes a real harmless job and deduplicates retained job IDs', async () => {
  const prefix = 'test-' + randomUUID(),
    q = createPingQueue(env.REDIS_URL, prefix),
    w = createPingWorker(env.REDIS_URL, prefix),
    e = createPingEvents(env.REDIS_URL, prefix);
  try {
    await e.events.waitUntilReady();
    await w.worker.waitUntilReady();
    const requestId = randomUUID(),
      data = { schemaVersion: 1 as const, requestId, message: 'integration' };
    const job = await q.queue.add('foundation.ping', data, {
      jobId: requestId,
    });
    expect(await job.waitUntilFinished(e.events, 15000)).toEqual({
      ok: true,
      requestId,
    });
    await q.queue.add('foundation.ping', data, { jobId: requestId });
    expect(await q.queue.getJobCounts('completed')).toMatchObject({
      completed: 1,
    });
  } finally {
    await w.close();
    await q.queue.obliterate({ force: true });
    await Promise.all([q.close(), e.close()]);
  }
});
it('retains exhausted invalid jobs after three attempts', async () => {
  const prefix = 'test-' + randomUUID(),
    q = createPingQueue(env.REDIS_URL, prefix),
    w = createPingWorker(env.REDIS_URL, prefix),
    e = createPingEvents(env.REDIS_URL, prefix);
  try {
    await e.events.waitUntilReady();
    const job = await q.queue.add('unknown.job', {
      schemaVersion: 1,
      requestId: randomUUID(),
      message: 'invalid name',
    });
    await expect(job.waitUntilFinished(e.events, 15000)).rejects.toThrow(
      'Unknown foundation job',
    );
    const failed = await q.queue.getJob(job.id!);
    expect(failed?.attemptsMade).toBe(3);
    expect(await failed?.getState()).toBe('failed');
  } finally {
    await w.close();
    await q.queue.obliterate({ force: true });
    await Promise.all([q.close(), e.close()]);
  }
});
