import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
config({ quiet: true });
if (
  process.env.RUN_PAYPAL_SANDBOX !== 'true' ||
  process.env.PAYPAL_ENABLED !== 'true' ||
  process.env.PAYPAL_ENVIRONMENT !== 'sandbox'
)
  throw Error(
    'Real Sandbox smoke requires RUN_PAYPAL_SANDBOX=true, PAYPAL_ENABLED=true and PAYPAL_ENVIRONMENT=sandbox',
  );
for (const key of [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_MERCHANT_ID',
  'PAYPAL_WEBHOOK_ID',
])
  if (!process.env[key])
    throw Error('Missing real Sandbox configuration: ' + key);
const orderId = z.uuid().parse(process.env.SANDBOX_ORDER_ID),
  base = process.env.API_PUBLIC_URL ?? 'http://localhost:3001',
  origin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const logged = await fetch(base + '/api/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({
    email: process.env.SANDBOX_CUSTOMER_EMAIL ?? 'customer@resolveai.test',
    password:
      process.env.SANDBOX_CUSTOMER_PASSWORD ?? process.env.DEV_SEED_PASSWORD,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!logged.ok) throw Error('Local customer authentication failed');
const login = z
  .object({ data: z.object({ csrfToken: z.string() }) })
  .parse(await logged.json());
const cookie = logged.headers.getSetCookie()[0]?.split(';')[0];
if (!cookie) throw Error('Session cookie missing');
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string,
  version?: number,
) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: cookie!,
      'x-csrf-token': login.data.csrfToken,
      ...(key ? { 'Idempotency-Key': key } : {}),
      ...(version !== undefined ? { 'If-Match': String(version) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error(`Local payment API returned ${response.status}`);
  return z
    .object({ data: z.record(z.string(), z.unknown()) })
    .parse(await response.json()).data;
}
const before = await call('/orders/' + orderId),
  create = await call(
    '/orders/' + orderId + '/checkout',
    'POST',
    {},
    randomUUID(),
    z.number().parse(before.version),
  );
let op = create;
for (
  let i = 0;
  i < 90 && (!op.providerOrderId || op.state !== 'COMPLETED');
  i++
) {
  if (op.state === 'FAILED') throw Error('Sandbox order creation failed');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  op = await call(
    '/payment-operations/' + z.string().parse(create.operationId),
  );
}
if (op.state !== 'COMPLETED')
  throw Error(
    'Provider order has not been verified; inspect reconciliation before approving',
  );
const providerOrderId = z.string().parse(op.providerOrderId);
console.log('Sandbox provider order:', providerOrderId);
if (typeof op.approvalUrl === 'string')
  console.log(
    'Open this approval URL with the separate Sandbox PERSONAL buyer account:',
    op.approvalUrl,
  );
else
  console.log(
    'Open ' +
      origin +
      '/checkout and approve this order using the Sandbox buyer.',
  );
const terminal = createInterface({ input: stdin, output: stdout });
try {
  await terminal.question(
    'After buyer approval, press Enter to request server capture: ',
  );
} finally {
  terminal.close();
}
let payment = await call('/orders/' + orderId + '/payments');
if (payment.status !== 'CAPTURED')
  await call(
    '/orders/' + orderId + '/capture',
    'POST',
    { providerOrderId },
    randomUUID(),
    z.number().parse(payment.version),
  );
for (let i = 0; i < 120; i++) {
  payment = await call('/orders/' + orderId + '/payments');
  if (payment.status === 'CAPTURED') break;
  if (payment.status === 'FAILED') throw Error('Sandbox capture failed');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (payment.status !== 'CAPTURED')
  throw Error(
    'Capture not confirmed; inspect reconciliation state without issuing another payment',
  );
const verified = z
  .object({
    providerCaptureId: z.string(),
    verifiedAt: z.string(),
    grossMinor: z.string(),
    currency: z.literal('USD'),
  })
  .parse(payment.capture);
const expected = z
  .object({ minor: z.string(), currency: z.literal('USD') })
  .parse(before.total);
if (verified.grossMinor !== expected.minor)
  throw Error('Verified capture does not match order total');
const result = {
  verifiedAt: verified.verifiedAt,
  providerOrderId,
  captureId: verified.providerCaptureId,
  minor: verified.grossMinor,
  currency: verified.currency,
  source: 'REAL_PAYPAL_SANDBOX',
};
mkdirSync('.local', { recursive: true });
writeFileSync('.local/sandbox-last-run.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
