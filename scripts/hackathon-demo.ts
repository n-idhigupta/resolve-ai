import { config } from 'dotenv';
import { createDatabase } from '../apps/api/src/database.js';
import { createHackathonFixture } from './hackathon-fixture.js';
config({ path: '.env', quiet: true });
if (
  process.env.NODE_ENV === 'production' ||
  process.env.ENABLE_DEV_SEED !== 'true'
)
  throw Error('Explicit development seed opt-in required');
for (const key of [
  'MIGRATION_DATABASE_URL',
  'DATABASE_URL',
  'AI_ARTIFACT_KEY',
  'DEV_SEED_PASSWORD',
])
  if (!process.env[key])
    throw Error('Local database/artifact/seed configuration required');
if (
  !['localhost', '127.0.0.1'].includes(
    new URL(process.env.MIGRATION_DATABASE_URL!).hostname,
  ) ||
  new URL(process.env.MIGRATION_DATABASE_URL!).pathname !== '/resolveai'
)
  throw Error('Local development database required');
const db = createDatabase(process.env.MIGRATION_DATABASE_URL!);
try {
  const f = await createHackathonFixture(
    db,
    process.env.DATABASE_URL!,
    process.env.AI_ARTIFACT_KEY!,
    process.env.DEV_SEED_PASSWORD!,
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      ai: 'local deterministic mock',
      refund: 'mock',
      merchantEmail: f.ownerEmail,
      customerEmail: f.customerEmail,
      passwordSource: 'Existing local DEV_SEED_PASSWORD; never printed',
      merchantUrl: `http://localhost:5173/merchant/${f.merchantId}/cases`,
      customerUrl: 'http://localhost:5173/orders',
      purchaseOrderId: f.purchaseOrderId,
      preparedCaseId: f.caseId,
      analyticsUrl: `http://localhost:5173/merchant/${f.merchantId}/analytics`,
    }),
  );
} finally {
  await db.$disconnect();
}
