import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  IntelligenceService,
  DISCLOSURE,
  readProviderSelection,
  GEMINI_DISCLOSURE,
  MOCK_DISCLOSURE,
  OPENAI_MODEL,
} from '@resolveai/ai-core';
import { json, member, fail } from '@resolveai/case-store';
import { requireSession, checkCsrf } from './auth.js';
import { withActorTransaction, type Database } from './database.js';
import type { Env } from './config.js';
export async function registerIntelligence(
  app: FastifyInstance,
  db: Database,
  env: Env,
  service?: IntelligenceService,
  enabled = process.env.AI_ENABLED === 'true' &&
    (readProviderSelection().provider === 'gemini'
      ? process.env.GEMINI_USAGE_CONFIRMED === 'true'
      : !!process.env.OPENAI_API_KEY),
) {
  const send = (r: FastifyRequest, data: unknown) => ({
    data: json(data),
    requestId: r.id,
  });
  async function actors(r: FastifyRequest) {
    const auth = await requireSession(r, db, env);
    if (r.method !== 'GET') checkCsrf(r, auth.session.tokenHash, env);
    const ids = await withActorTransaction(db, auth.user.id, async (tx) => {
      const memberships = await tx.membership.findMany({
          where: { userId: auth.user.id, active: true },
        }),
        ownership = await tx.customerOrder.findMany({
          where: { userId: auth.user.id },
        });
      return [
        ...new Set([...memberships, ...ownership].map((x) => x.merchantId)),
      ];
    });
    return ids.map((merchantId) => ({ merchantId, userId: auth.user.id }));
  }
  async function scope(r: FastifyRequest, merchantOnly = false) {
    if (!service) fail('AI_NOT_CONFIGURED', 503);
    const p = r.params as Record<string, string>;
    if (p.caseId) z.uuid().parse(p.caseId);
    if (p.merchantId) z.uuid().parse(p.merchantId);
    for (const a of await actors(r)) {
      if (p.merchantId && p.merchantId !== a.merchantId) continue;
      const ok = await service!.tx(a, async (tx) => {
        const role = await member(tx, a);
        if (merchantOnly && !role) return false;
        return (
          !p.caseId ||
          !!(await tx.query('SELECT id FROM "Case" WHERE id=$1', [p.caseId]))
            .rows[0]
        );
      });
      if (ok) return a;
    }
    return fail('NOT_FOUND', 404);
  }
  const key = (r: FastifyRequest) =>
    z.string().min(1).max(128).parse(r.headers['idempotency-key']);
  const version = (r: FastifyRequest) => {
    const s = r.headers['if-match'];
    if (typeof s !== 'string' || !/^"?\d+"?$/.test(s))
      return fail('VERSION_REQUIRED', 428);
    return Number(s.replaceAll('"', ''));
  };
  app.get('/api/v1/ai/config', async (r) => {
    await requireSession(r, db, env);
    const query = z
      .strictObject({ caseId: z.uuid().optional() })
      .parse(r.query);
    let mock = false;
    if (query.caseId && service) {
      let found = false;
      for (const a of await actors(r)) {
        const record = await service.tx(
          a,
          async (tx) =>
            (
              await tx.query(
                'SELECT c.id,EXISTS(SELECT 1 FROM "DemoTenant" d WHERE d."merchantId"=c."merchantId") AS mock FROM "Case" c WHERE c.id=$1',
                [query.caseId],
              )
            ).rows[0],
        );
        if (record) {
          found = true;
          mock = record.mock;
          break;
        }
      }
      if (!found) fail('NOT_FOUND', 404);
    }
    if (mock)
      return send(r, {
        configured: !!service,
        enabled: true,
        provider: 'openai',
        executionMode: 'mock',
        syntheticOnly: true,
        model: OPENAI_MODEL,
        nonbinding: true,
        disclosure: MOCK_DISCLOSURE,
      });
    return send(r, {
      executionMode: 'external',
      configured: !!service,
      enabled,
      provider: readProviderSelection().provider,
      syntheticOnly: readProviderSelection().provider === 'gemini',
      model: readProviderSelection().model,
      nonbinding: true,
      disclosure:
        readProviderSelection().provider === 'gemini'
          ? GEMINI_DISCLOSURE
          : DISCLOSURE,
    });
  });
  const merchant = '/api/v1/merchants/:merchantId';
  const casePath = '/api/v1/cases/:caseId';
  app.get(merchant + '/ai-sharing-policies', async (r) => {
    const a = await scope(r);
    return send(
      r,
      await service!.tx(
        a,
        async (tx) =>
          (
            await tx.query(
              'SELECT id,sequence,"modelId","providerId",enabled,"dailyBudgetMicros"::text,"policyHash",disclosure,"createdAt" FROM "AISharingPolicy" ORDER BY sequence DESC LIMIT 100',
            )
          ).rows,
      ),
    );
  });
  app.post(merchant + '/ai-sharing-policies', async (r, reply) => {
    const a = await scope(r, true);
    return reply
      .code(201)
      .send(send(r, await service!.sharingPolicy(a, r.body)));
  });
  app.post(casePath + '/ai-sharing-previews', async (r, reply) => {
    const a = await scope(r);
    return reply
      .code(202)
      .send(
        send(
          r,
          await service!.preview(
            a,
            (r.params as Record<string, string>).caseId!,
            r.body,
            key(r),
          ),
        ),
      );
  });
  app.get(casePath + '/ai-sharing-previews/:contextId', async (r) => {
    const a = await scope(r),
      p = r.params as Record<string, string>;
    return send(
      r,
      await service!.readPreview(a, p.caseId!, z.uuid().parse(p.contextId)),
    );
  });
  app.get(casePath + '/ai-consents', async (r) => {
    const a = await scope(r),
      caseId = (r.params as Record<string, string>).caseId;
    return send(
      r,
      await service!.tx(
        a,
        async (tx) =>
          (
            await tx.query(
              'SELECT c.id,c."contextId",c."sharingPolicyId",c."consentHash",c."createdAt",EXISTS(SELECT 1 FROM "AIRevocation" rv WHERE rv."consentId"=c.id) AS revoked FROM "AIConsent" c WHERE c."caseId"=$1 ORDER BY c."createdAt" DESC LIMIT 100',
              [caseId],
            )
          ).rows,
      ),
    );
  });
  app.post(casePath + '/ai-consents', async (r, reply) => {
    const a = await scope(r),
      caseId = (r.params as Record<string, string>).caseId!,
      body = z
        .strictObject({
          contextId: z.uuid(),
          sharingPolicyId: z.uuid(),
          consentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(r.body);
    return reply
      .code(201)
      .send(send(r, await service!.consent(a, caseId, body)));
  });
  app.post(casePath + '/ai-consents/:consentId/revoke', async (r) => {
    z.strictObject({}).parse(r.body);
    const a = await scope(r),
      p = r.params as Record<string, string>;
    return send(
      r,
      await service!.revoke(a, p.caseId!, z.uuid().parse(p.consentId)),
    );
  });
  const analyses = merchant + '/cases/:caseId/analyses';
  app.post(analyses, async (r, reply) => {
    const a = await scope(r, true);
    const mockPolicy = await service!.tx(
      a,
      async (tx) =>
        (
          await tx.query(
            'SELECT p."executionMode",p.enabled FROM "AISharingPolicy" p JOIN "DemoTenant" d ON d."merchantId"=p."merchantId" ORDER BY p.sequence DESC LIMIT 1',
          )
        ).rows[0],
    );
    if (
      !enabled &&
      !(mockPolicy?.executionMode === 'mock' && mockPolicy.enabled)
    )
      fail('AI_PROVIDER_NOT_CONFIGURED', 503);
    const body = z.strictObject({ consentId: z.uuid() }).parse(r.body);
    return reply
      .code(202)
      .send(
        send(
          r,
          await service!.start(
            a,
            (r.params as Record<string, string>).caseId!,
            body.consentId,
            key(r),
            version(r),
          ),
        ),
      );
  });
  app.get(analyses, async (r) => {
    const a = await scope(r, true),
      q = z
        .strictObject({
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.uuid().optional(),
        })
        .parse(r.query);
    return send(
      r,
      await service!.tx(
        a,
        async (tx) =>
          (
            await tx.query(
              'SELECT id,status,"modelId","promptVersion","createdAt",version FROM "Analysis" WHERE "caseId"=$1 AND "contextId" IS NOT NULL AND ($2::uuid IS NULL OR ("createdAt",id)<(SELECT "createdAt",id FROM "Analysis" WHERE id=$2)) ORDER BY "createdAt" DESC,id DESC LIMIT $3',
              [
                (r.params as Record<string, string>).caseId,
                q.cursor ?? null,
                q.limit,
              ],
            )
          ).rows,
      ),
    );
  });
  app.get(analyses + '/:analysisId', async (r) => {
    const a = await scope(r, true),
      p = r.params as Record<string, string>;
    return send(
      r,
      await service!.detail(a, p.caseId!, z.uuid().parse(p.analysisId)),
    );
  });
  app.get(analyses + '/:analysisId/sources/:sourceId', async (r) => {
    const a = await scope(r, true),
      p = r.params as Record<string, string>;
    const detail = await service!.detail(
      a,
      p.caseId!,
      z.uuid().parse(p.analysisId),
    );
    if (detail.revoked) fail('CONSENT_REVOKED', 409);
    const source = await service!.tx(
      a,
      async (tx) =>
        (
          await tx.query(
            'SELECT "sourceKey" FROM "AnalysisSource" WHERE "analysisId"=$1 AND "sourceKey"=$2',
            [
              p.analysisId,
              z
                .string()
                .regex(/^S[0-9]{3,5}$/)
                .parse(p.sourceId),
            ],
          )
        ).rows[0],
    );
    if (!source) fail('NOT_FOUND', 404);
    return send(r, await service!.source(a, p.analysisId!, source.sourceKey));
  });
  app.post(analyses + '/:analysisId/reviews', async (r) => {
    const a = await scope(r, true),
      p = r.params as Record<string, string>;
    return send(
      r,
      await service!.review(
        a,
        p.caseId!,
        z.uuid().parse(p.analysisId),
        r.body,
        version(r),
        key(r),
      ),
    );
  });
  app.get(merchant + '/ai-usage', async (r) => {
    const a = await scope(r, true);
    return send(
      r,
      await service!.tx(a, async (tx) => ({
        daily: (
          await tx.query(
            'SELECT day,"committedMicros"::text FROM "AIBudget" ORDER BY day DESC LIMIT 30',
          )
        ).rows,
        attempts: (
          await tx.query(
            'SELECT "analysisId",attempt,status,"reservedMicros"::text,"chargedMicros"::text,"usageJson","priceVersion","createdAt" FROM "AIUsage" ORDER BY "createdAt" DESC LIMIT 100',
          )
        ).rows,
        estimated: true,
      })),
    );
  });
}
