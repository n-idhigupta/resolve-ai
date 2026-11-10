import pg from 'pg';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
const settings = parse(readFileSync('.env.test'));
const url = settings.MIGRATION_DATABASE_URL;
if (!url || new URL(url).pathname !== '/resolveai_test')
  throw Error('Isolated test database required');
const pool = new pg.Pool({ connectionString: url });
try {
  const r = await pool.query(
    `SELECT r.state,r."lastErrorCode",r."firstDispatchAt" IS NOT NULL AS dispatched,r."providerRefundId" IS NOT NULL AS observed,count(*) OVER() AS count FROM "RefundOperation" r JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE a."refundMode"='mock' ORDER BY r."createdAt" DESC LIMIT 8`,
  );
  console.log(JSON.stringify({ syntheticOnly: true, operations: r.rows }));
} finally {
  await pool.end();
}
