import { startIntelligenceWorker } from './intelligence-worker.js';
import { MockAIProvider } from '@resolveai/ai-core';
if (
  process.env.NODE_ENV === 'production' ||
  process.env.RESOLVEAI_WORKER_ISOLATED !== 'true' ||
  Object.keys(process.env).some((k) =>
    /^(PAYPAL_|OPENAI_|GEMINI_|MIGRATION_DATABASE_URL|DATABASE_URL|WORKER_DATABASE_URL)/.test(
      k,
    ),
  )
)
  throw Error('ISOLATED_LOCAL_MOCK_ENVIRONMENT_REQUIRED');
const mode = process.argv.includes('--prepare') ? 'prepare' : 'infer';
if (
  mode === 'infer' &&
  Object.keys(process.env).some(
    (k) => k.startsWith('S3_') || k === 'EVIDENCE_DATABASE_URL',
  )
)
  throw Error('INFERENCE_STORAGE_CREDENTIALS_FORBIDDEN');
const worker = await startIntelligenceWorker({
  mode,
  databaseUrl: (mode === 'infer'
    ? process.env.AI_DATABASE_URL
    : process.env.EVIDENCE_DATABASE_URL)!,
  redisUrl: process.env.REDIS_URL!,
  key: process.env.AI_ARTIFACT_KEY!,
  mockOnly: true,
  ...(mode === 'infer' ? { provider: new MockAIProvider() } : {}),
  prefix: 'resolveai-demo',
});
console.log(
  'Synthetic local mock intelligence worker ready; no external inference.',
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void worker.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
