import { startEvidenceWorker } from './evidence-worker.js';
import { startIntelligenceWorker } from './intelligence-worker.js';
const evidence = await startEvidenceWorker(
  process.env.REDIS_URL!,
  process.env.EVIDENCE_DATABASE_URL!,
);
const preparation = process.env.AI_ARTIFACT_KEY
  ? await startIntelligenceWorker({
      mode: 'prepare',
      databaseUrl: process.env.EVIDENCE_DATABASE_URL!,
      redisUrl: process.env.REDIS_URL!,
      key: process.env.AI_ARTIFACT_KEY,
    })
  : undefined;
console.log(
  'Evidence/preparation worker ready; no PayPal or provider credentials.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void Promise.allSettled([evidence.close(), preparation?.close()]);
  });
