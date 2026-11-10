import { config } from 'dotenv';
import { createDatabase } from '../apps/api/src/database.js';
import { createSettlementFixture } from './settlement-fixture.js';
config({ path: '.env', quiet: true });
if (
  process.env.NODE_ENV === 'production' ||
  process.env.ENABLE_DEV_SEED !== 'true' ||
  !process.env.DEV_SEED_PASSWORD ||
  process.env.DEV_SEED_PASSWORD.length < 20
)
  throw Error(
    'Explicit development seed opt-in and configured password required',
  );
const url = process.env.MIGRATION_DATABASE_URL!;
if (new URL(url).pathname !== '/resolveai')
  throw Error('Local development database required');
const db = createDatabase(url);
try {
  const f = await createSettlementFixture(
    db,
    process.env.DEV_SEED_PASSWORD,
    'resolve_payments',
  );
  console.log(
    JSON.stringify({
      synthetic: true,
      financialProvider: 'mock',
      merchantEmail: f.ownerEmail,
      customerEmail: f.customerEmail,
      caseId: f.caseId,
      merchantId: f.merchantId,
      passwordSource: 'Existing local DEV_SEED_PASSWORD; not printed',
    }),
  );
} finally {
  await db.$disconnect();
}
