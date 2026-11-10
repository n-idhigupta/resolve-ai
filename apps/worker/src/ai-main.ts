import {
  createOpenAIProvider,
  createGeminiProvider,
  readProviderSelection,
} from '@resolveai/ai-core';
import {
  assertInferenceEnvironment,
  startIntelligenceWorker,
} from './intelligence-worker.js';
if (process.env.AI_ENABLED !== 'true') throw Error('AI_INFERENCE_DISABLED');
assertInferenceEnvironment(process.env);
const runtime = await startIntelligenceWorker({
  mode: 'infer',
  databaseUrl: process.env.AI_DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
  key: process.env.AI_ARTIFACT_KEY!,
  provider:
    readProviderSelection().provider === 'gemini'
      ? createGeminiProvider(process.env.GEMINI_API_KEY!)
      : createOpenAIProvider(process.env.OPENAI_API_KEY!),
});
console.log(
  'AI inference worker ready; no payment or original-storage credentials.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void runtime.close();
  });
