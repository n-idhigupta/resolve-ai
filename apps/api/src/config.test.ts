import { describe, it, expect } from 'vitest';
import { envSchema } from './config.js';
const valid = {
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://runtime:local@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_HASH_PEPPER: 'a'.repeat(32),
  CSRF_SECRET: 'b'.repeat(32),
};
describe('environment', () => {
  it('allows disabled integrations without credentials', () => {
    expect(envSchema.parse(valid).API_PORT).toBe(3001);
  });
  it('rejects invalid/missing secrets', () => {
    expect(() => envSchema.parse({ ...valid, CSRF_SECRET: '' })).toThrow();
    expect(() =>
      envSchema.parse({ ...valid, DATABASE_URL: 'https://example.com' }),
    ).toThrow();
  });
  it('rejects a webhook URL used as a webhook ID', () => {
    expect(() =>
      envSchema.parse({
        ...valid,
        PAYPAL_WEBHOOK_ID: 'https://example.test/webhook',
      }),
    ).toThrow();
  });
  it('rejects production seed', () => {
    expect(() =>
      envSchema.parse({
        ...valid,
        NODE_ENV: 'production',
        ENABLE_DEV_SEED: 'true',
      }),
    ).toThrow();
  });
});
it('validates configured AI provider/model pairs without requiring a key in the API', () => {
  expect(
    envSchema.parse({
      ...valid,
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gemini-2.5-flash',
    }).AI_PROVIDER,
  ).toBe('gemini');
  expect(() =>
    envSchema.parse({
      ...valid,
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gpt-5.4-mini-2026-03-17',
    }),
  ).toThrow();
  expect(() => envSchema.parse({ ...valid, AI_PROVIDER: 'unknown' })).toThrow();
  expect(() =>
    envSchema.parse({
      ...valid,
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gemini-latest',
    }),
  ).toThrow();
});

it('fails closed for Sandbox or refund flags in production', () => {
  const production = {
    ...valid,
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://resolve.example',
  };
  expect(envSchema.safeParse(production).success).toBe(true);
  expect(() =>
    envSchema.parse({ ...production, PAYPAL_ENABLED: 'true' }),
  ).toThrow();
  expect(() =>
    envSchema.parse({ ...production, PAYPAL_REFUNDS_ENABLED: 'true' }),
  ).toThrow();
  expect(envSchema.parse(valid).API_HOST).toBe('127.0.0.1');
});
