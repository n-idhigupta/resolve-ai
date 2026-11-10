import { it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { env, runtime, migration, password } from './helpers.js';
import { createSettlementFixture } from '../../scripts/settlement-fixture.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerAuth } from '../../apps/api/src/auth.js';
import { registerCases } from '../../apps/api/src/cases.js';
import { assertSafeRuntime } from '../../apps/api/src/database.js';
import { CaseStore } from '../../packages/case-store/dist/index.js';
import { PaymentDatabase } from '../../packages/payment-store/dist/index.js';
const prod = {
  ...env,
  NODE_ENV: 'production' as const,
  WEB_ORIGIN: 'https://synthetic-demo.example',
  PAYPAL_ENABLED: 'false' as const,
  PAYPAL_REFUNDS_ENABLED: 'false' as const,
};
const db = new PaymentDatabase(env.DATABASE_URL),
  store = new CaseStore(db);
const app = await createApp(prod, {
  checkDatabase: async () => 1,
  checkRedis: async () => 1,
  close: async () => {},
});
const saved = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('S3_')),
);
for (const k of Object.keys(saved)) delete process.env[k];
try {
  await registerAuth(app, runtime, prod);
  await registerCases(app, runtime, store, prod, { evidenceEnabled: false });
} finally {
  Object.assign(process.env, saved);
}
let f: Awaited<ReturnType<typeof createSettlementFixture>>,
  other: Awaited<ReturnType<typeof createSettlementFixture>>,
  cookie = '',
  csrf = '';
beforeAll(async () => {
  await assertSafeRuntime(runtime);
  f = await createSettlementFixture(migration, password);
  other = await createSettlementFixture(migration, password);
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: prod.WEB_ORIGIN },
    payload: { email: f.customerEmail, password },
  });
  expect(r.statusCode).toBe(200);
  const set = r.headers['set-cookie'];
  const first = (Array.isArray(set) ? set[0] : set)!;
  expect(first).toContain('Secure');
  expect(first).toContain('HttpOnly');
  cookie = first.split(';')[0]!;
  csrf = r.json().data.csrfToken;
});
afterAll(async () => {
  await app.close();
  await Promise.all([
    runtime.$disconnect(),
    migration.$disconnect(),
    db.close(),
  ]);
});
it('keeps production authentication and tenant isolation with storage disabled', async () => {
  expect((await app.inject('/api/v1/cases/' + f.caseId)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: '/api/v1/cases/' + f.caseId,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: '/api/v1/cases/' + other.caseId,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(404);
});
it('rejects upload initiation before creating evidence and retains CSRF enforcement', async () => {
  const url = '/api/v1/cases/' + f.caseId + '/evidence/uploads';
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin: prod.WEB_ORIGIN },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const before = await migration.evidence.count({
    where: { caseId: f.caseId },
  });
  const r = await app.inject({
    method: 'POST',
    url,
    headers: { cookie, origin: prod.WEB_ORIGIN, 'x-csrf-token': csrf },
    payload: {},
  });
  expect(r.statusCode).toBe(503);
  expect(r.body).toContain('EVIDENCE_DISABLED');
  expect(await migration.evidence.count({ where: { caseId: f.caseId } })).toBe(
    before,
  );
});
it('rejects evidence content, completion and download without storage calls', async () => {
  const root = '/api/v1/cases/' + f.caseId + '/evidence/' + randomUUID();
  for (const [method, path, payload] of [
    ['PUT', '/content', Buffer.from('synthetic')],
    ['POST', '/complete', {}],
    ['GET', '/download', undefined],
  ] as const) {
    const r = await app.inject({
      method,
      url: root + path,
      headers: {
        cookie,
        origin: prod.WEB_ORIGIN,
        'x-csrf-token': csrf,
        ...(method === 'PUT'
          ? { 'content-type': 'application/octet-stream' }
          : {}),
      },
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('EVIDENCE_DISABLED');
  }
});
it('does not change normal production storage requirements', async () => {
  const normal = await createApp(prod, {
    checkDatabase: async () => 1,
    checkRedis: async () => 1,
    close: async () => {},
  });
  for (const k of Object.keys(saved)) delete process.env[k];
  try {
    await expect(registerCases(normal, runtime, store, prod)).rejects.toThrow();
  } finally {
    Object.assign(process.env, saved);
    await normal.close();
  }
});
