import '../src/config.js';
import { createDatabase } from '../src/database.js';
import { seedDevelopment } from '../src/dev-fixtures.js';
if (!process.env.MIGRATION_DATABASE_URL)
  throw Error('Migration credentials required');
const db = createDatabase(process.env.MIGRATION_DATABASE_URL);
try {
  await seedDevelopment(db, {
    nodeEnv: process.env.NODE_ENV ?? 'production',
    enabled: process.env.ENABLE_DEV_SEED === 'true',
    password: process.env.DEV_SEED_PASSWORD ?? '',
  });
  console.log(
    'Seeded development identities and three unpaid owned orders. Password remains in ignored local settings.',
  );
} finally {
  await db.$disconnect();
}
