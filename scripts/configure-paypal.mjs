import { config } from 'dotenv';
import pg from 'pg';
config({ quiet: true });
if (process.env.NODE_ENV === 'production')
  throw Error('Sandbox configuration helper is development-only');
for (const name of [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_MERCHANT_ID',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_TENANT_ID',
  'WORKER_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'WEBHOOK_PAYLOAD_ENCRYPTION_KEY',
])
  if (!process.env[name]) throw Error('Required setting is missing: ' + name);
if (
  process.env.PAYPAL_ENVIRONMENT !== 'sandbox' ||
  process.env.PAYPAL_ENABLED !== 'true'
)
  throw Error('Explicit Sandbox enablement is required');
if (!/^[a-f0-9]{64}$/.test(process.env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY))
  throw Error('Generate a 32-byte hexadecimal receipt-encryption key');
const tenant = process.env.PAYPAL_TENANT_ID;
if (!/^[a-f0-9-]{36}$/i.test(tenant))
  throw Error('Invalid local merchant UUID');
const role = new URL(process.env.WORKER_DATABASE_URL).username;
if (role !== 'resolve_payments')
  throw Error('Expected dedicated local payment-worker role');
const accountKey = process.env.PAYPAL_ACCOUNT_KEY ?? 'demo-sandbox';
if (!/^[a-zA-Z0-9_-]{1,100}$/.test(accountKey))
  throw Error('Invalid account key');
const db = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
await db.connect();
try {
  await db.query('BEGIN');
  const merchant = await db.query(
    'SELECT id FROM "Merchant" WHERE id=$1 AND status=\'ACTIVE\'',
    [tenant],
  );
  if (!merchant.rowCount)
    throw Error('Configured local merchant is missing or inactive');
  const existing = await db.query(
    'SELECT "merchantId" FROM "PaymentAccount" WHERE environment=\'sandbox\' AND "providerMerchantId"=$1',
    [process.env.PAYPAL_MERCHANT_ID],
  );
  if (existing.rows[0] && existing.rows[0].merchantId !== tenant)
    throw Error('This seller is already bound to another tenant');
  await db.query(
    `INSERT INTO "PaymentAccount"("merchantId",environment,"providerMerchantId","credentialSecretRef","webhookId","accountKey",enabled,"workerRoleName") VALUES($1,'sandbox',$2,'env:PAYPAL_CLIENT_SECRET',$3,$4,true,$5) ON CONFLICT(environment,"providerMerchantId") DO UPDATE SET "webhookId"=EXCLUDED."webhookId","accountKey"=EXCLUDED."accountKey",enabled=true,"workerRoleName"=EXCLUDED."workerRoleName"`,
    [
      tenant,
      process.env.PAYPAL_MERCHANT_ID,
      process.env.PAYPAL_WEBHOOK_ID,
      accountKey,
      role,
    ],
  );
  await db.query('COMMIT');
  console.log(
    'Bound one Sandbox seller to the specified tenant and restricted payment-worker role. No provider call was made.',
  );
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
