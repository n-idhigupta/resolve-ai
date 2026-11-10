import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (
  existsSync('.env') ||
  existsSync('.env.test') ||
  existsSync('.local/bootstrap.sql')
)
  throw Error(
    'Local configuration already exists; refusing to overwrite credentials',
  );
const secret = () => randomBytes(32).toString('hex');
const admin = secret(),
  migration = secret(),
  runtime = secret(),
  test = secret(),
  redis = secret(),
  s3Key = secret(),
  s3Secret = secret(),
  password = secret();
mkdirSync('.local', { recursive: true });
const common = {
  NODE_ENV: 'development',
  API_PORT: '3001',
  WEB_ORIGIN: 'http://localhost:5173',
  API_PUBLIC_URL: 'http://localhost:3001',
  VITE_API_BASE_URL: '/api/v1',
  SESSION_HASH_PEPPER: secret(),
  CSRF_SECRET: secret(),
  REDIS_URL: `redis://:${redis}@localhost:6379`,
  REDIS_PASSWORD: redis,
  POSTGRES_ADMIN_PASSWORD: admin,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: s3Key,
  S3_SECRET_ACCESS_KEY: s3Secret,
  S3_QUARANTINE_BUCKET: 'resolveai-quarantine-local',
  S3_CLEAN_BUCKET: 'resolveai-clean-local',
  ENABLE_DEV_SEED: 'true',
  DEV_SEED_PASSWORD: password,
  LIVE_PAYMENTS_ENABLED: 'false',
  PAYPAL_FORMAL_DISPUTES_ENABLED: 'false',
  LOG_LEVEL: 'info',
  WORKER_CONCURRENCY: '4',
};
const lines = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
writeFileSync(
  '.env',
  lines({
    ...common,
    DATABASE_URL: `postgresql://resolve_runtime:${runtime}@localhost:5432/resolveai`,
    MIGRATION_DATABASE_URL: `postgresql://resolve_migrator:${migration}@localhost:5432/resolveai`,
  }),
);
writeFileSync(
  '.env.test',
  lines({
    ...common,
    NODE_ENV: 'test',
    DATABASE_URL: `postgresql://resolve_test:${test}@localhost:5432/resolveai_test`,
    MIGRATION_DATABASE_URL: `postgresql://resolve_migrator:${migration}@localhost:5432/resolveai_test`,
    LOG_LEVEL: 'silent',
  }),
);
writeFileSync(
  '.local/bootstrap.sql',
  `CREATE ROLE resolve_migrator LOGIN PASSWORD '${migration}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE resolve_runtime LOGIN PASSWORD '${runtime}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE resolve_test LOGIN PASSWORD '${test}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER DATABASE resolveai OWNER TO resolve_migrator;
REVOKE CONNECT ON DATABASE resolveai FROM PUBLIC;
GRANT CONNECT ON DATABASE resolveai TO resolve_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO resolve_migrator;
CREATE DATABASE resolveai_test OWNER resolve_migrator;
REVOKE CONNECT ON DATABASE resolveai_test FROM PUBLIC;
GRANT CONNECT ON DATABASE resolveai_test TO resolve_test;
\\connect resolveai_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO resolve_migrator;
`,
);
writeFileSync(
  '.local/s3.json',
  JSON.stringify({
    identities: [
      {
        name: 'local-development',
        credentials: [{ accessKey: s3Key, secretKey: s3Secret }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  }),
);
console.log(
  'Created ignored local/test settings and credentials. Read DEV_SEED_PASSWORD locally; it is not printed.',
);
