import { it, expect } from 'vitest';
import { createApp } from './app.js';
import { envSchema } from './config.js';
const env = envSchema.parse({
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://localhost/db',
  REDIS_URL: 'redis://localhost',
  SESSION_HASH_PEPPER: 'a'.repeat(32),
  CSRF_SECRET: 'b'.repeat(32),
  LOG_LEVEL: 'silent',
});
it('health is liveness and readiness checks dependencies', async () => {
  const app = await createApp(env, {
    checkDatabase: async () => 1,
    checkRedis: async () => 1,
    close: async () => {},
  });
  try {
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(200);
    expect((await app.inject('/missing')).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
it('readiness fails safely when dependencies fail', async () => {
  const app = await createApp(env, {
    checkDatabase: async () => {
      throw Error('secret connection string');
    },
    checkRedis: async () => 1,
    close: async () => {},
  });
  try {
    const r = await app.inject('/ready');
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('secret');
  } finally {
    await app.close();
  }
});
