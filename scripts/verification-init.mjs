if (
  process.env.RESOLVEAI_CREATE_VERIFY_ACK !== 'CREATE_NEW_DISPOSABLE_DATABASE'
)
  throw Error('EXPLICIT_DATABASE_CREATION_ACK_REQUIRED');
import fs from 'node:fs';
import pg from 'pg';
import { parse } from 'dotenv';
import { spawnSync } from 'node:child_process';
const name = 'resolveai_verify_20261110',
  v = parse(fs.readFileSync('.env', 'utf8')),
  test = parse(fs.readFileSync('.env.test', 'utf8'));
const admin = new URL(v.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(admin.hostname))
  throw Error('LOCAL_ONLY');
admin.username = 'resolve_admin';
admin.password = encodeURIComponent(v.POSTGRES_ADMIN_PASSWORD);
admin.pathname = '/postgres';
const db = new pg.Client({ connectionString: admin.href });
await db.connect();
try {
  if (
    (await db.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rowCount
  )
    throw Error('VERIFICATION_DATABASE_EXISTS_NO_RESET');
  await db.query('CREATE DATABASE ' + name + ' OWNER resolve_migrator');
  await db.query('REVOKE CONNECT ON DATABASE ' + name + ' FROM PUBLIC');
  await db.query(
    'GRANT CONNECT ON DATABASE ' +
      name +
      ' TO resolve_test,resolve_payments_test,resolve_ai_test,resolve_evidence_test',
  );
} finally {
  await db.end();
}
for (const key of [
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'EVIDENCE_DATABASE_URL',
  'AI_DATABASE_URL',
]) {
  const u = new URL(test[key]);
  u.pathname = '/' + name;
  test[key] = u.href;
}
for (const k of Object.keys(test))
  if (/^(PAYPAL_|OPENAI_|GEMINI_)/.test(k)) delete test[k];
Object.assign(test, {
  AI_PROVIDER: 'openai',
  AI_MODEL: '',
  AI_ENABLED: 'false',
  PAYPAL_ENABLED: 'false',
  PAYPAL_REFUNDS_ENABLED: 'false',
  GEMINI_USAGE_CONFIRMED: 'false',
  NODE_ENV: 'test',
});
const redis = new URL(test.REDIS_URL);
redis.pathname = '/15';
test.REDIS_URL = redis.href;
test.S3_QUARANTINE_BUCKET = 'verify-20261110-quarantine';
test.S3_CLEAN_BUCKET = 'verify-20261110-clean';
fs.writeFileSync(
  '.local/verification.env',
  Object.entries(test)
    .map(([k, val]) => k + '=' + JSON.stringify(val))
    .join('\n') + '\n',
  { mode: 0o600 },
);
const r = spawnSync(
  process.execPath,
  [
    'apps/api/node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    'apps/api/prisma.config.ts',
  ],
  { env: { ...process.env, ...test }, stdio: 'inherit', windowsHide: true },
);
if (r.status !== 0) throw Error('NEW_DATABASE_MIGRATION_FAILED');
console.log(
  'New verification database created and migrated; existing databases unchanged.',
);

const buckets = spawnSync(process.execPath, ['scripts/storage-init.mjs'], {
  env: { ...process.env, ...test },
  stdio: 'inherit',
  windowsHide: true,
});
if (buckets.status !== 0) throw Error('VERIFICATION_BUCKET_INIT_FAILED');
