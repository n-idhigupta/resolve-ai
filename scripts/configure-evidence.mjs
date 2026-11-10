import { config, parse } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
config({ quiet: true });
if (process.env.NODE_ENV === 'production')
  throw Error('Development helper only');
for (const file of ['.env', '.env.test']) {
  const text = readFileSync(file, 'utf8'),
    env = parse(text),
    url = new URL(env.MIGRATION_DATABASE_URL);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !['/resolveai', '/resolveai_test'].includes(url.pathname)
  )
    throw Error('Local database required');
  const role = new URL(env.EVIDENCE_DATABASE_URL).username;
  if (!['resolve_evidence', 'resolve_evidence_test'].includes(role))
    throw Error('Dedicated role required');
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  try {
    for (const id of [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ])
      await db.query(
        'INSERT INTO "EvidenceWorkerTenant"("merchantId","roleName") SELECT id,$2 FROM "Merchant" WHERE id=$1 ON CONFLICT DO NOTHING',
        [id, role],
      );
  } finally {
    await db.end();
  }
  if (!/^EVIDENCE_ENABLED=/m.test(text))
    writeFileSync(
      file,
      text.trimEnd() +
        '\nEVIDENCE_ENABLED=true\nCLAMAV_HOST=127.0.0.1\nCLAMAV_PORT=3310\n',
    );
}
console.log('Assigned only seeded local tenants to dedicated evidence roles.');
