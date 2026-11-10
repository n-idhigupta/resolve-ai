import { config } from 'dotenv';
import { createDatabase } from '../../apps/api/src/database.js';
import { envSchema } from '../../apps/api/src/config.js';
export const testDatabaseName =
  process.env.RESOLVEAI_VERIFY_DATABASE === 'resolveai_verify_20261110'
    ? 'resolveai_verify_20261110'
    : 'resolveai_test';
const isolated =
  config({
    path:
      testDatabaseName === 'resolveai_test'
        ? '.env.test'
        : '.local/verification.env',
    override: true,
    quiet: true,
  }).parsed ?? {};
process.env.AI_PROVIDER = isolated.AI_PROVIDER ?? 'openai';
process.env.AI_MODEL = isolated.AI_MODEL ?? '';
process.env.AI_ENABLED = 'false';
process.env.GEMINI_USAGE_CONFIRMED = 'false';
delete process.env.GEMINI_API_KEY;
if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== '/' + testDatabaseName
)
  throw Error('Integration tests require isolated .env.test database');
const runtimeUrl = new URL(process.env.DATABASE_URL!);
const migrationUrl = new URL(
  process.env.MIGRATION_DATABASE_URL ?? 'postgresql://invalid/invalid',
);
if (
  migrationUrl.pathname !== '/' + testDatabaseName ||
  migrationUrl.hostname !== runtimeUrl.hostname ||
  migrationUrl.port !== runtimeUrl.port
)
  throw Error(
    'Migration and runtime credentials must target the same isolated test database',
  );
export const env = envSchema.parse(process.env);
export const runtime = createDatabase(env.DATABASE_URL);
export const migration = createDatabase(process.env.MIGRATION_DATABASE_URL!);
export const password = process.env.DEV_SEED_PASSWORD!;

export function assertDisposableReset() {
  if (
    testDatabaseName !== 'resolveai_verify_20261110' &&
    process.env.CI !== 'true'
  )
    throw Error('RESET_REQUIRES_APPROVED_DISPOSABLE_VERIFICATION_DATABASE');
}
