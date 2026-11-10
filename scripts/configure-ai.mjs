import { config, parse } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
config({ quiet: true });
if (process.env.NODE_ENV === 'production') throw Error('Local helper only');
for (const file of ['.env', '.env.test']) {
  let text = readFileSync(file, 'utf8');
  const env = parse(text),
    url = new URL(env.MIGRATION_DATABASE_URL);
  if (
    !['/resolveai', '/resolveai_test'].includes(url.pathname) ||
    !['localhost', '127.0.0.1'].includes(url.hostname)
  )
    throw Error('Isolated/local target required');
  const role = new URL(env.AI_DATABASE_URL).username;
  if (!['resolve_ai', 'resolve_ai_test'].includes(role))
    throw Error('Dedicated AI role required');
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  try {
    for (const tenant of [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ])
      await db.query(
        'INSERT INTO "AIWorkerTenant"("merchantId","roleName") SELECT id,$2 FROM "Merchant" WHERE id=$1 ON CONFLICT DO NOTHING',
        [tenant, role],
      );
  } finally {
    await db.end();
  }
  if (!env.AI_ARTIFACT_KEY)
    text += '\nAI_ARTIFACT_KEY=' + randomBytes(32).toString('hex') + '\n';
  if (!('AI_ENABLED' in env)) text += 'AI_ENABLED=false\n';
  writeFileSync(file, text);
}
console.log(
  'Assigned seeded tenants and generated ignored AI artifact keys. Provider stays disabled; sharing policies and customer consent remain explicit.',
);
