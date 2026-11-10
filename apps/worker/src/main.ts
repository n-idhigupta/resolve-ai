import { startEvidenceWorker } from './evidence-worker.js';
import { workerEnvSchema } from './config.js';
import { createPingWorker } from './queue.js';
import { startConfiguredPayments } from './payment-worker.js';
const env = workerEnvSchema.parse(process.env),
  ping = createPingWorker(env.REDIS_URL, 'resolveai', env.WORKER_CONCURRENCY);
let evidence: { close: () => Promise<void> } | undefined;
let payments: { close: () => Promise<void> } | undefined;
try {
  await ping.worker.waitUntilReady();
  if (process.env.EVIDENCE_ENABLED === 'true') {
    if (!process.env.EVIDENCE_DATABASE_URL)
      throw Error('Evidence database URL required');
    evidence = await startEvidenceWorker(
      env.REDIS_URL,
      process.env.EVIDENCE_DATABASE_URL,
    );
  }
  if (process.env.PAYPAL_ENABLED === 'true')
    payments = await startConfiguredPayments(env.REDIS_URL);
  console.log(
    payments
      ? 'Worker ready: Sandbox payments and foundation ping.'
      : 'Worker ready: foundation ping; Sandbox payments disabled.',
  );
} catch {
  await ping.close();
  console.error('Worker startup failed; check role and payment configuration.');
  process.exitCode = 1;
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.allSettled([ping.close(), payments?.close(), evidence?.close()]);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
