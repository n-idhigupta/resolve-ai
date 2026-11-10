import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CaseStore,
  NegotiationStore,
  SettlementStore,
  EvidenceService,
  PrivateStorage,
  storageEnvSchema,
  json,
  member,
  fail,
  type Actor,
} from '@resolveai/case-store';
import { complaintReasonSchema, policyDocumentSchema } from '@resolveai/shared';
import { requireSession, checkCsrf } from './auth.js';
import { withActorTransaction, type Database } from './database.js';
import type { Env } from './config.js';
const id = (v: unknown) => z.uuid().parse(v);
const paging = z
  .strictObject({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.string().max(40).optional(),
    reason: complaintReasonSchema.optional(),
    orderId: z.uuid().optional(),
    search: z.string().trim().max(100).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
  })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      (Date.parse(q.to) > Date.parse(q.from) &&
        Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000),
    'Date range must be positive and at most 366 days',
  );
export async function registerCases(
  app: FastifyInstance,
  db: Database,
  store: CaseStore,
  env: Env,
  options: { evidenceEnabled?: boolean } = {},
) {
  const evidence =
    options.evidenceEnabled === false
      ? undefined
      : new EvidenceService(
          store,
          new PrivateStorage(storageEnvSchema.parse(process.env)),
        );
  const requireEvidence = () => {
    if (!evidence) fail('EVIDENCE_DISABLED', 503);
    return evidence!;
  };
  async function actors(request: FastifyRequest) {
    const auth = await requireSession(request, db, env);
    if (!['GET', 'HEAD'].includes(request.method))
      checkCsrf(request, auth.session.tokenHash, env);
    const merchants = await withActorTransaction(
      db,
      auth.user.id,
      async (tx) => {
        const m = await tx.membership.findMany({
            where: { userId: auth.user.id, active: true },
          }),
          o = await tx.customerOrder.findMany({
            where: { userId: auth.user.id },
          });
        return [...new Set([...m, ...o].map((r) => r.merchantId))];
      },
    );
    return merchants.map((merchantId) => ({
      merchantId,
      userId: auth.user.id,
    }));
  }
  async function scope(
    request: FastifyRequest,
    type: 'case' | 'order' | 'merchant',
    target: string,
  ): Promise<Actor> {
    for (const a of await actors(request)) {
      const found = await store.tx(a, async (tx) => {
        if (type === 'merchant')
          return a.merchantId === target && !!(await member(tx, a));
        return !!(
          await tx.query(
            type === 'case'
              ? 'SELECT id FROM "Case" WHERE id=$1'
              : 'SELECT id FROM "Order" WHERE id=$1',
            [target],
          )
        ).rows[0];
      });
      if (found) return a;
    }
    return fail('NOT_FOUND', 404);
  }
  const key = (r: FastifyRequest) =>
    z.string().min(1).max(128).parse(r.headers['idempotency-key']);
  const version = (r: FastifyRequest) => {
    const v = r.headers['if-match'];
    if (typeof v !== 'string' || !/^"?\d+"?$/.test(v))
      return fail('VERSION_REQUIRED', 428);
    return z.coerce.number().int().nonnegative().parse(v.replaceAll('"', ''));
  };
  const send = (r: FastifyRequest, data: unknown) => ({
    data: json(data),
    requestId: r.id,
  });
  const negotiation = new NegotiationStore(store);
  const settlements = new SettlementStore(store);
  app.get('/api/v1/cases/:caseId/settlements', async (r) => {
    const caseId = id((r.params as Record<string, string>).caseId),
      a = await scope(r, 'case', caseId);
    return send(r, await settlements.list(a, caseId));
  });
  app.post('/api/v1/cases/:caseId/proposals/:proposalId/accept', async (r) => {
    const p = r.params as Record<string, string>,
      caseId = id(p.caseId),
      a = await scope(r, 'case', caseId),
      auth = await requireSession(r, db, env);
    return send(
      r,
      await settlements.accept(
        a,
        caseId,
        id(p.proposalId),
        r.body,
        version(r),
        key(r),
        auth.session.authenticatedAt,
      ),
    );
  });
  app.post(
    '/api/v1/cases/:caseId/settlements/:settlementId/authorize',
    async (r) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId),
        auth = await requireSession(r, db, env);
      return send(
        r,
        await settlements.authorize(
          a,
          caseId,
          id(p.settlementId),
          r.body,
          version(r),
          key(r),
          auth.session.authenticatedAt,
        ),
      );
    },
  );
  app.post(
    '/api/v1/cases/:caseId/settlements/:settlementId/cancel',
    async (r) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      return send(
        r,
        await settlements.cancel(
          a,
          caseId,
          id(p.settlementId),
          r.body,
          version(r),
          key(r),
        ),
      );
    },
  );
  app.post(
    '/api/v1/cases/:caseId/settlements/:settlementId/reconcile',
    async (r) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      z.strictObject({}).parse(r.body);
      return send(
        r,
        await store.tx(a, async (tx) => {
          const role = await member(tx, a);
          if (!role || !['OWNER', 'APPROVER'].includes(role))
            fail('FORBIDDEN', 403);
          const c = await store.locked(tx, a, caseId);
          if (c.version !== version(r)) fail('STALE_VERSION');
          const row = (
            await tx.query(
              'UPDATE "RefundOperation" r SET "nextAttemptAt"=now() FROM "Settlement" s WHERE s.id=$1 AND s."caseId"=$2 AND r.id=s."refundOperationId" AND r.state IN (\'UNKNOWN\',\'PENDING\') RETURNING r.id',
              [id(p.settlementId), caseId],
            )
          ).rows[0];
          if (!row) fail('RECONCILIATION_NOT_AVAILABLE');
          return { operationId: row.id, scheduled: true };
        }),
      );
    },
  );

  app.post(
    '/api/v1/cases/:caseId/settlements/:settlementId/fulfillment',
    async (r) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      return send(
        r,
        await settlements.fulfillment(
          a,
          caseId,
          id(p.settlementId),
          r.body,
          version(r),
          key(r),
        ),
      );
    },
  );
  app.get('/api/v1/cases/:caseId/proposals', async (r) => {
    const caseId = id((r.params as Record<string, string>).caseId),
      a = await scope(r, 'case', caseId);
    const q = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.coerce.number().int().positive().optional(),
      })
      .parse(r.query);
    return send(r, await negotiation.list(a, caseId, q.limit, q.cursor));
  });
  app.post(
    '/api/v1/merchants/:merchantId/cases/:caseId/proposals',
    async (r, reply) => {
      const p = r.params as Record<string, string>,
        merchant = await scope(r, 'merchant', id(p.merchantId)),
        caseId = id(p.caseId);
      return reply
        .code(201)
        .send(
          send(
            r,
            await negotiation.create(
              merchant,
              caseId,
              r.body,
              version(r),
              key(r),
            ),
          ),
        );
    },
  );
  app.post(
    '/api/v1/cases/:caseId/proposals/:proposalId/counter',
    async (r, reply) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      return reply
        .code(201)
        .send(
          send(
            r,
            await negotiation.create(
              a,
              caseId,
              r.body,
              version(r),
              key(r),
              id(p.proposalId),
            ),
          ),
        );
    },
  );
  app.post('/api/v1/cases/:caseId/proposals/:proposalId/actions', async (r) => {
    const p = r.params as Record<string, string>,
      caseId = id(p.caseId),
      a = await scope(r, 'case', caseId);
    return send(
      r,
      await negotiation.action(
        a,
        caseId,
        id(p.proposalId),
        r.body,
        version(r),
        key(r),
      ),
    );
  });
  app.get('/api/v1/orders/:orderId/complaint-eligibility', async (r) => {
    const p = r.params as Record<string, string>,
      orderId = id(p.orderId),
      q = z
        .strictObject({ reason: complaintReasonSchema.default('OTHER') })
        .parse(r.query),
      a = await scope(r, 'order', orderId);
    const result = await store.tx(a, (tx) =>
      store.eligibility(tx, a, orderId, q.reason),
    );
    return send(r, {
      ...result.policy,
      caseCount: result.caseCount,
      maxCases: 3,
      cooldownHours: 24,
      policyVersionId: result.order.purchasePolicyVersionId,
    });
  });
  app.post('/api/v1/cases', async (r, reply) => {
    const body = z.object({ orderId: z.uuid() }).passthrough().parse(r.body),
      a = await scope(r, 'order', body.orderId);
    return reply.code(201).send(send(r, await store.create(a, r.body, key(r))));
  });
  async function listing(r: FastifyRequest, merchant?: string) {
    const q = paging.parse(r.query),
      actorsToRead = merchant
        ? [await scope(r, 'merchant', merchant)]
        : await actors(r);
    const rows = [];
    const direction = q.sort === 'oldest' ? 'ASC' : 'DESC',
      comparison = q.sort === 'oldest' ? '>' : '<';
    for (const a of actorsToRead) {
      const set = await store.tx(a, (tx) =>
        tx.query(
          `SELECT c.* ${merchant ? `,(SELECT jsonb_build_object('status',an.status,'stale',NOT ai_context_fresh(an."contextId"),'revoked',EXISTS(SELECT 1 FROM "AIRevocation" rv WHERE rv."consentId"=an."consentId")) FROM "Analysis" an WHERE an."merchantId"=c."merchantId" AND an."caseId"=c.id AND an."contextId" IS NOT NULL ORDER BY an."createdAt" DESC,an.id DESC LIMIT 1) AS "aiReview"` : ''} FROM "Case" c WHERE ($1::uuid IS NULL OR (c."createdAt",c.id) ${comparison} (SELECT "createdAt",id FROM "Case" WHERE id=$1)) AND ($2::text IS NULL OR status::text=$2) AND ($3::text IS NULL OR reason::text=$3) AND ($4::uuid IS NULL OR "orderId"=$4) AND ($5::text IS NULL OR title ILIKE $5 OR "orderId"::text ILIKE $5) AND ($6::timestamptz IS NULL OR "createdAt">=$6) AND ($7::timestamptz IS NULL OR "createdAt"<$7) AND ($8::boolean OR "openedBy"=$9) ORDER BY c."createdAt" ${direction},c.id ${direction} LIMIT $10`,
          [
            q.cursor ?? null,
            q.status ?? null,
            q.reason ?? null,
            q.orderId ?? null,
            q.search ? '%' + q.search + '%' : null,
            q.from ?? null,
            q.to ?? null,
            !!merchant,
            a.userId,
            q.limit + 1,
          ],
        ),
      );
      rows.push(...set.rows);
    }
    rows.sort(
      (a, b) =>
        (q.sort === 'oldest' ? 1 : -1) *
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
          String(a.id).localeCompare(String(b.id))),
    );
    return {
      ...send(r, rows.slice(0, q.limit)),
      page: {
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]?.id : null,
      },
    };
  }
  app.get('/api/v1/cases', (r) => listing(r));
  app.get('/api/v1/merchants/:merchantId/cases', (r) =>
    listing(r, id((r.params as Record<string, string>).merchantId)),
  );
  app.get('/api/v1/cases/:caseId', async (r) => {
    const caseId = id((r.params as Record<string, string>).caseId),
      a = await scope(r, 'case', caseId);
    return send(
      r,
      await store.tx(a, async (tx) => {
        const row = (
          await tx.query('SELECT * FROM "Case" WHERE id=$1', [caseId])
        ).rows[0];
        const order = (
          await tx.query(
            'SELECT o.id,o.status,o."paymentState",o."amountMinor"::text,o.currency,c."providerCaptureId",c."verifiedAt" FROM "Order" o LEFT JOIN "Capture" c ON c."orderId"=o.id AND c."merchantId"=o."merchantId" WHERE o.id=$1',
            [row.orderId],
          )
        ).rows[0];
        return {
          ...row,
          order,
          merchantActor: !!(await member(tx, a)),
          comments: (
            await tx.query(
              'SELECT * FROM "CaseComment" WHERE "caseId"=$1 ORDER BY "createdAt",id LIMIT 25',
              [caseId],
            )
          ).rows,
          timeline: (
            await tx.query(
              'SELECT * FROM "CaseTimelineEvent" WHERE "caseId"=$1 ORDER BY "createdAt",id LIMIT 25',
              [caseId],
            )
          ).rows,
          evidence: (
            await tx.query(
              'SELECT id,filename,"scanStatus","uploadState","failureCode" FROM "Evidence" WHERE "caseId"=$1 ORDER BY "createdAt",id',
              [caseId],
            )
          ).rows,
        };
      }),
    );
  });
  for (const resource of ['comments', 'timeline', 'evidence'] as const)
    app.get('/api/v1/cases/:caseId/' + resource, async (r) => {
      const caseId = id((r.params as Record<string, string>).caseId),
        a = await scope(r, 'case', caseId);
      const q = z
        .strictObject({
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(r.query);
      const columns =
        resource === 'evidence'
          ? 'id,filename,"scanStatus","uploadState","detectedType","sizeBytes"::text,"failureCode","scannedAt","createdAt"'
          : '*';
      const table =
        resource === 'comments'
          ? 'CaseComment'
          : resource === 'timeline'
            ? 'CaseTimelineEvent'
            : 'Evidence';
      const rows = await store.tx(a, (tx) =>
        tx.query(
          `SELECT ${columns} FROM "${table}" WHERE "caseId"=$1 AND ($2::uuid IS NULL OR ("createdAt",id)>(SELECT "createdAt",id FROM "${table}" WHERE id=$2)) ORDER BY "createdAt",id LIMIT $3`,
          [caseId, q.cursor ?? null, q.limit + 1],
        ),
      );
      return {
        ...send(r, rows.rows.slice(0, q.limit)),
        page: {
          nextCursor:
            rows.rows.length > q.limit ? rows.rows[q.limit - 1]?.id : null,
        },
      };
    });
  app.post('/api/v1/cases/:caseId/comments', async (r) => {
    const caseId = id((r.params as Record<string, string>).caseId),
      a = await scope(r, 'case', caseId),
      body = z
        .strictObject({
          body: z.string().trim().min(1).max(2000),
          visibility: z.enum(['CUSTOMER', 'INTERNAL']).default('CUSTOMER'),
        })
        .parse(r.body);
    return send(r, await store.comment(a, caseId, body, version(r), key(r)));
  });
  for (const path of [
    '/api/v1/cases/:caseId/actions',
    '/api/v1/merchants/:merchantId/cases/:caseId/actions',
  ])
    app.post(path, async (r) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      if (p.merchantId) {
        if (
          a.merchantId !== id(p.merchantId) ||
          !(await store.tx(a, (tx) => member(tx, a)))
        )
          fail('NOT_FOUND', 404);
      } else if (await store.tx(a, (tx) => member(tx, a)))
        fail('CUSTOMER_ACTION_REQUIRED', 403);
      return send(r, await store.action(a, caseId, r.body, version(r), key(r)));
    });
  app.post('/api/v1/cases/:caseId/evidence/uploads', async (r, reply) => {
    const caseId = id((r.params as Record<string, string>).caseId),
      a = await scope(r, 'case', caseId);
    requireEvidence();
    return reply.code(201).send(
      send(r, {
        ...(await store.evidence(a, caseId, r.body, version(r), key(r))),
        uploadContentType: 'application/octet-stream',
        uploadMethod: 'PUT',
      }),
    );
  });
  await app.register(async (upload) => {
    upload.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 10485760 },
      (_r, b, done) => done(null, b),
    );
    upload.put(
      '/api/v1/cases/:caseId/evidence/:evidenceId/content',
      { bodyLimit: 10485760 },
      async (r) => {
        const p = r.params as Record<string, string>,
          caseId = id(p.caseId),
          a = await scope(r, 'case', caseId);
        if (!Buffer.isBuffer(r.body)) fail('BINARY_BODY_REQUIRED', 422);
        return send(
          r,
          await requireEvidence().upload(
            a,
            caseId,
            id(p.evidenceId),
            r.body as Buffer,
          ),
        );
      },
    );
  });
  app.post(
    '/api/v1/cases/:caseId/evidence/:evidenceId/complete',
    async (r, reply) => {
      z.strictObject({}).parse(r.body);
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId);
      reply.code(202);
      return send(
        r,
        await requireEvidence().complete(
          a,
          caseId,
          id(p.evidenceId),
          key(r),
          version(r),
        ),
      );
    },
  );
  app.get(
    '/api/v1/cases/:caseId/evidence/:evidenceId/download',
    async (r, reply) => {
      const p = r.params as Record<string, string>,
        caseId = id(p.caseId),
        a = await scope(r, 'case', caseId),
        file = await requireEvidence().download(a, caseId, id(p.evidenceId));
      return reply
        .type(file.mime)
        .header('Content-Disposition', 'attachment; filename="evidence"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .send(file.bytes);
    },
  );
  const base = '/api/v1/merchants/:merchantId/policies';
  for (const kind of ['drafts', 'versions'] as const)
    app.get(base + '/' + kind, async (r) => {
      const merchantId = id((r.params as Record<string, string>).merchantId),
        a = await scope(r, 'merchant', merchantId);
      return send(
        r,
        await store.tx(a, async (tx) => {
          if (kind === 'drafts' && (await member(tx, a)) !== 'OWNER')
            fail('FORBIDDEN', 403);
          return (
            await tx.query(
              kind === 'drafts'
                ? 'SELECT * FROM "PolicyDraft" ORDER BY "createdAt" DESC LIMIT 100'
                : 'SELECT * FROM "PolicyVersion" WHERE "publishedAt" IS NOT NULL ORDER BY sequence DESC LIMIT 100',
            )
          ).rows;
        }),
      );
    });
  app.post(base + '/drafts', async (r) => {
    const a = await scope(
      r,
      'merchant',
      id((r.params as Record<string, string>).merchantId),
    );
    return send(r, await store.policy(a, 'create', undefined, r.body, 0));
  });
  app.put(base + '/drafts/:draftId', async (r) => {
    const p = r.params as Record<string, string>,
      a = await scope(r, 'merchant', id(p.merchantId));
    return send(
      r,
      await store.policy(a, 'edit', id(p.draftId), r.body, version(r)),
    );
  });
  app.post(base + '/drafts/:draftId/validate', async (r) => {
    const p = r.params as Record<string, string>,
      a = await scope(r, 'merchant', id(p.merchantId));
    const row = await store.tx(a, (tx) =>
      tx.query('SELECT document FROM "PolicyDraft" WHERE id=$1', [
        id(p.draftId),
      ]),
    );
    if (!row.rows[0]) fail('NOT_FOUND', 404);
    policyDocumentSchema.parse(row.rows[0].document);
    return send(r, { valid: true });
  });
  app.post(base + '/drafts/:draftId/publish', async (r) => {
    const p = r.params as Record<string, string>,
      a = await scope(r, 'merchant', id(p.merchantId));
    z.strictObject({}).parse(r.body);
    return send(
      r,
      await store.policy(a, 'publish', id(p.draftId), {}, version(r)),
    );
  });
  app.get(base + '/versions/:versionId', async (r) => {
    const p = r.params as Record<string, string>,
      a = await scope(r, 'merchant', id(p.merchantId));
    return send(
      r,
      await store.tx(a, async (tx) => {
        const row = (
          await tx.query('SELECT * FROM "PolicyVersion" WHERE id=$1', [
            id(p.versionId),
          ])
        ).rows[0];
        if (!row) fail('NOT_FOUND', 404);
        return {
          ...row,
          clauses: (
            await tx.query(
              'SELECT "clauseKey",text,"rulesJson" FROM "PolicyClause" WHERE "policyVersionId"=$1',
              [id(p.versionId)],
            )
          ).rows,
        };
      }),
    );
  });
}
