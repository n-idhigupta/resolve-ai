import { registerAnalytics } from './analytics.js';
import { IntelligenceService } from '@resolveai/ai-core';
import { registerIntelligence } from './intelligence.js';
import { CaseStore } from '@resolveai/case-store';
import { registerCases } from './cases.js';
import { PaymentDatabase, PaymentStore } from '@resolveai/payment-store';
import { registerPayments } from './payments.js';
import { Redis } from 'ioredis';
import { readEnv } from './config.js';
import { createApp } from './app.js';
import { createDatabase, assertSafeRuntime } from './database.js';
import { registerAuth } from './auth.js';
import { registerOrders } from './orders.js';
const env = readEnv(),
  db = createDatabase(env.DATABASE_URL),
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
const paymentDb = new PaymentDatabase(env.DATABASE_URL);
redis.on('error', () => {});
try {
  await assertSafeRuntime(db);
  const app = await createApp(env, {
    checkDatabase: () => db.$queryRaw`SELECT 1`,
    checkRedis: () => redis.ping(),
    close: async () => {
      await Promise.allSettled([
        db.$disconnect(),
        redis.quit(),
        paymentDb.close(),
      ]);
    },
  });
  await registerAuth(app, db, env);
  await registerOrders(app, db, env);
  await registerAnalytics(app, db, paymentDb, env);
  await registerCases(app, db, new CaseStore(paymentDb), env);
  await registerIntelligence(
    app,
    db,
    env,
    process.env.AI_ARTIFACT_KEY
      ? new IntelligenceService(paymentDb, process.env.AI_ARTIFACT_KEY)
      : undefined,
  );
  await registerPayments(app, db, new PaymentStore(paymentDb), env);
  const stop = async () => {
    await app.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch {
  console.error(
    'API startup failed; check environment, migrations and runtime privileges.',
  );
  await Promise.allSettled([db.$disconnect(), redis.quit()]);
  process.exitCode = 1;
}
