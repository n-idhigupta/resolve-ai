import { it, expect } from 'vitest';
import { assertFreeDemoEnvironment } from './free-demo-config.js';
const safe = {
  RESOLVEAI_FREE_DEMO: 'true',
  NODE_ENV: 'production',
  PAYPAL_ENABLED: 'false',
  PAYPAL_REFUNDS_ENABLED: 'false',
  AI_ENABLED: 'false',
  EVIDENCE_ENABLED: 'false',
  ENABLE_DEV_SEED: 'false',
};
it('requires explicit free-demo opt-in and production cookie/security mode', () => {
  expect(() => assertFreeDemoEnvironment(safe)).not.toThrow();
  expect(() =>
    assertFreeDemoEnvironment({ ...safe, RESOLVEAI_FREE_DEMO: undefined }),
  ).toThrow();
  expect(() =>
    assertFreeDemoEnvironment({ ...safe, NODE_ENV: 'development' }),
  ).toThrow();
});
it('refuses every execution/seed enablement and forbidden credential', () => {
  for (const key of [
    'PAYPAL_ENABLED',
    'PAYPAL_REFUNDS_ENABLED',
    'AI_ENABLED',
    'EVIDENCE_ENABLED',
    'ENABLE_DEV_SEED',
  ])
    expect(() =>
      assertFreeDemoEnvironment({ ...safe, [key]: 'true' }),
    ).toThrow();
  for (const key of [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'PAYPAL_CLIENT_SECRET',
    'S3_SECRET_ACCESS_KEY',
    'AI_ARTIFACT_KEY',
    'MIGRATION_DATABASE_URL',
    'WORKER_DATABASE_URL',
  ])
    expect(() =>
      assertFreeDemoEnvironment({
        ...safe,
        [key]: 'synthetic-forbidden-value',
      }),
    ).toThrow();
});
