import { randomUUID } from 'node:crypto';
import {
  PaymentDatabase,
  PaymentError,
  hashPayload,
  type Tx,
} from '@resolveai/payment-store';
import {
  caseInputSchema,
  caseActionSchema,
  policyDocumentSchema,
  evidenceInputSchema,
  activeCaseStates,
} from '@resolveai/shared';
import {
  complaintPolicy,
  caseTransition,
  repeatComplaintAllowed,
} from '@resolveai/policy-engine';
export const fail = (code: string, status = 409): never => {
  throw new PaymentError(status, code, code.replaceAll('_', ' '));
};
export type Actor = { userId: string; merchantId: string };
export const json = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  );
export async function member(tx: Tx, a: Actor) {
  return (
    await tx.query(
      'SELECT role FROM "Membership" WHERE "merchantId"=$1 AND "userId"=$2 AND active',
      [a.merchantId, a.userId],
    )
  ).rows[0]?.role as string | undefined;
}
export async function event(
  tx: Tx,
  a: Actor,
  id: string,
  action: string,
  previous: string | null,
  next: string | null,
  metadata: unknown = {},
  visibility = 'CUSTOMER',
) {
  await tx.query(
    'INSERT INTO "CaseTimelineEvent"("merchantId","caseId","actorId",action,"previousStatus","newStatus",visibility,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      a.merchantId,
      id,
      a.userId,
      action,
      previous,
      next,
      visibility,
      JSON.stringify(metadata),
    ],
  );
  await tx.query(
    'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType","actorId",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'Case\',$2,\'USER\',$3,$4,$5,$6,$7)',
    [
      a.merchantId,
      id,
      a.userId,
      action,
      visibility,
      randomUUID(),
      JSON.stringify(metadata),
    ],
  );
}
export async function replay(
  tx: Tx,
  a: Actor,
  scope: string,
  key: string,
  body: unknown,
) {
  if (!key || key.length > 128) fail('IDEMPOTENCY_KEY_REQUIRED', 422);
  const old = (
    await tx.query(
      'SELECT "requestHash","resultRef" FROM "IdempotencyRecord" WHERE "merchantId"=$1 AND "actorId"=$2 AND "routeScope"=$3 AND key=$4',
      [a.merchantId, a.userId, 'cases:' + scope, key],
    )
  ).rows[0];
  if (old) {
    if (old.requestHash !== hashPayload(body)) fail('IDEMPOTENCY_CONFLICT');
    return old.resultRef;
  }
  return null;
}
export async function remember(
  tx: Tx,
  a: Actor,
  scope: string,
  key: string,
  body: unknown,
  result: unknown,
) {
  await tx.query(
    'INSERT INTO "IdempotencyRecord"("merchantId","actorId","routeScope",key,"requestHash","resultRef","expiresAt") VALUES($1,$2,$3,$4,$5,$6,\'9999-12-31T00:00:00Z\')',
    [
      a.merchantId,
      a.userId,
      'cases:' + scope,
      key,
      hashPayload(body),
      JSON.stringify(json(result)),
    ],
  );
}
export class CaseStore {
  constructor(readonly db: PaymentDatabase) {}
  tx<T>(a: Actor, fn: (tx: Tx) => Promise<T>) {
    return this.db.transaction(a.merchantId, a.userId, fn);
  }
  async locked(tx: Tx, a: Actor, id: string, version?: number) {
    const row = (
      await tx.query(
        'SELECT * FROM "Case" WHERE id=$1 AND "merchantId"=$2 FOR UPDATE',
        [id, a.merchantId],
      )
    ).rows[0];
    if (!row) fail('NOT_FOUND', 404);
    if (version !== undefined && row.version !== version) fail('STALE_VERSION');
    return row;
  }
  async eligibility(tx: Tx, a: Actor, orderId: string, reason = 'OTHER') {
    const order = (
      await tx.query(
        'SELECT o.*,c."completedAt",c."verifiedAt",c."reconciliationStatus",m.status AS "merchantStatus" FROM "Order" o JOIN "Merchant" m ON m.id=o."merchantId" LEFT JOIN "Capture" c ON c."orderId"=o.id AND c."merchantId"=o."merchantId" WHERE o.id=$1 AND o."merchantId"=$2 AND o."customerUserId"=$3',
        [orderId, a.merchantId, a.userId],
      )
    ).rows[0];
    if (!order) fail('NOT_FOUND', 404);
    const history = (
      await tx.query(
        'SELECT status,"closedAt" FROM "Case" WHERE "orderId"=$1 ORDER BY "createdAt" DESC',
        [orderId],
      )
    ).rows;
    const clauses = (
      await tx.query(
        'SELECT "rulesJson" FROM "PolicyClause" WHERE "policyVersionId"=$1',
        [order.purchasePolicyVersionId],
      )
    ).rows;
    const rules = complaintPolicy(
      clauses.map((c) => c.rulesJson),
      reason,
      order.completedAt ?? new Date(),
      new Date(),
      BigInt(order.amountMinor),
    );
    const reasons = [...rules.blockingReasons];
    if (
      order.status !== 'PAID' ||
      order.paymentState !== 'CAPTURED' ||
      !order.verifiedAt ||
      order.reconciliationStatus !== 'CURRENT'
    )
      reasons.push('VERIFIED_PAYMENT_REQUIRED');
    if (order.merchantStatus !== 'ACTIVE') reasons.push('MERCHANT_UNAVAILABLE');
    if (
      history.some(
        (c) => !['RESOLVED', 'CLOSED_WITHOUT_AGREEMENT'].includes(c.status),
      )
    )
      reasons.push('ACTIVE_CASE_EXISTS');
    if (
      !repeatComplaintAllowed(
        history.length,
        history[0]?.closedAt ?? null,
        new Date(),
      )
    )
      reasons.push('REPEAT_LIMIT_OR_COOLDOWN');
    return {
      order,
      policy: { ...rules, eligible: !reasons.length, blockingReasons: reasons },
      caseCount: history.length,
    };
  }
  async create(a: Actor, input: unknown, key: string) {
    const body = caseInputSchema.parse(input);
    return this.tx(a, async (tx) => {
      await tx.query(
        'SELECT id FROM "Order" WHERE id=$1 AND "customerUserId"=$2 FOR UPDATE',
        [body.orderId, a.userId],
      );
      const previous = await replay(tx, a, 'create', key, body);
      if (previous) return previous;
      const { order, policy } = await this.eligibility(
        tx,
        a,
        body.orderId,
        body.reason,
      );
      if (!policy.eligible)
        fail(policy.blockingReasons[0] ?? 'INELIGIBLE', 422);
      const row = (
        await tx.query(
          'INSERT INTO "Case"("merchantId","orderId","openedBy","policyVersionId",reason,title,description,"requestedOutcome","desiredResolution","policySnapshot") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            a.merchantId,
            body.orderId,
            a.userId,
            order.purchasePolicyVersionId,
            body.reason,
            body.title,
            body.description,
            body.requestedOutcome,
            body.desiredResolution,
            JSON.stringify(policy),
          ],
        )
      ).rows[0];
      await event(tx, a, row.id, 'SUBMITTED', null, 'OPEN', {
        legacyPolicy: policy.legacy,
        reviewReasons: policy.reviewReasons,
      });
      await remember(tx, a, 'create', key, body, row);
      return row;
    });
  }
  async action(
    a: Actor,
    id: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = caseActionSchema.parse(input);
    return this.tx(a, async (tx) => {
      const row = await this.locked(tx, a, id);
      const old = await replay(tx, a, 'action:' + id, key, body);
      if (old) return old;
      if (row.version !== version) fail('STALE_VERSION');
      if (
        (
          await tx.query(
            "SELECT id FROM \"Settlement\" WHERE \"caseId\"=$1 AND state NOT IN ('CANCELLED','FAILED','COMPLETED')",
            [id],
          )
        ).rows[0]
      )
        fail('SETTLEMENT_PENDING');
      const merchant = !!(await member(tx, a));
      let next: string = row.status;
      try {
        next = caseTransition(row.status, body.action, merchant, body.message);
      } catch (e) {
        fail(e instanceof Error ? e.message : 'ACTION_NOT_ALLOWED', 422);
      }
      const result = (
        await tx.query(
          'UPDATE "Case" SET status=$2::"CaseStatus",version=version+1,"updatedAt"=now(),"closedAt"=CASE WHEN $2=\'CLOSED_WITHOUT_AGREEMENT\' THEN now() ELSE NULL END,"closureReason"=CASE WHEN $2=\'CLOSED_WITHOUT_AGREEMENT\' THEN $3 ELSE NULL END WHERE id=$1 RETURNING *',
          [id, next!, body.message],
        )
      ).rows[0];
      if (body.message)
        await tx.query(
          'INSERT INTO "CaseComment"("merchantId","caseId","authorId",visibility,body) VALUES($1,$2,$3,\'CUSTOMER\',$4)',
          [a.merchantId, id, a.userId, body.message],
        );
      await event(tx, a, id, body.action, row.status, next!, {
        nonfinancialClosure: next !== 'CLOSED_WITHOUT_AGREEMENT' ? false : true,
      });
      await remember(tx, a, 'action:' + id, key, body, result);
      return result;
    });
  }
  async comment(
    a: Actor,
    id: string,
    body: { body: string; visibility: string },
    version: number,
    key: string,
  ) {
    return this.tx(a, async (tx) => {
      const row = await this.locked(tx, a, id);
      const prior = await replay(tx, a, 'comment:' + id, key, body);
      if (prior) return prior;
      if (row.version !== version) fail('STALE_VERSION');
      if (!(activeCaseStates as readonly string[]).includes(row.status))
        fail('CASE_CLOSED');
      if (body.visibility === 'INTERNAL' && !(await member(tx, a)))
        fail('FORBIDDEN', 403);
      const result = (
        await tx.query(
          'INSERT INTO "CaseComment"("merchantId","caseId","authorId",visibility,body) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [a.merchantId, id, a.userId, body.visibility, body.body],
        )
      ).rows[0];
      await tx.query(
        'UPDATE "Case" SET version=version+1,"updatedAt"=now() WHERE id=$1',
        [id],
      );
      await event(
        tx,
        a,
        id,
        'COMMENT_ADDED',
        row.status,
        row.status,
        {},
        body.visibility,
      );
      await remember(tx, a, 'comment:' + id, key, body, result);
      return result;
    });
  }
  async evidence(
    a: Actor,
    id: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = evidenceInputSchema.parse(input);
    return this.tx(a, async (tx) => {
      const row = await this.locked(tx, a, id);
      const old = await replay(tx, a, 'upload:' + id, key, body);
      if (old) return old;
      if (row.version !== version) fail('STALE_VERSION');
      if (!(activeCaseStates as readonly string[]).includes(row.status))
        fail('CASE_CLOSED');
      const count = (
        await tx.query(
          'SELECT count(*)::int n FROM "Evidence" WHERE "caseId"=$1 AND "uploadState"<>\'EXPIRED\'',
          [id],
        )
      ).rows[0].n;
      if (count >= 10) fail('EVIDENCE_LIMIT', 422);
      const evidenceId = randomUUID();
      const result = (
        await tx.query(
          'INSERT INTO "Evidence"(id,"merchantId","caseId","uploaderUserId","objectKey",filename,"declaredType","sizeBytes",sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,"expiresAt"',
          [
            evidenceId,
            a.merchantId,
            id,
            a.userId,
            `${a.merchantId}/${id}/${evidenceId}/${randomUUID()}`,
            body.filename,
            body.declaredType,
            body.sizeBytes,
            body.sha256,
          ],
        )
      ).rows[0];
      await tx.query('UPDATE "Case" SET version=version+1 WHERE id=$1', [id]);
      await event(tx, a, id, 'EVIDENCE_RESERVED', row.status, row.status, {
        evidenceId,
      });
      await remember(tx, a, 'upload:' + id, key, body, result);
      return result;
    });
  }
  async policy(
    a: Actor,
    operation: string,
    id: string | undefined,
    input: unknown,
    version: number,
  ) {
    return this.tx(a, async (tx) => {
      if ((await member(tx, a)) !== 'OWNER') fail('FORBIDDEN', 403);
      if (operation === 'create') {
        const doc = policyDocumentSchema.parse(input);
        return (
          await tx.query(
            'INSERT INTO "PolicyDraft"("merchantId",document) VALUES($1,$2) RETURNING *',
            [a.merchantId, JSON.stringify(doc)],
          )
        ).rows[0];
      }
      const draft = (
        await tx.query(
          'SELECT * FROM "PolicyDraft" WHERE id=$1 AND "merchantId"=$2 FOR UPDATE',
          [id, a.merchantId],
        )
      ).rows[0];
      if (!draft) fail('NOT_FOUND', 404);
      if (draft.version !== version) fail('STALE_VERSION');
      if (draft.publishedVersionId) fail('DRAFT_PUBLISHED');
      if (operation === 'edit') {
        const doc = policyDocumentSchema.parse(input);
        return (
          await tx.query(
            'UPDATE "PolicyDraft" SET document=$2,version=version+1 WHERE id=$1 RETURNING *',
            [id, JSON.stringify(doc)],
          )
        ).rows[0];
      }
      const doc = policyDocumentSchema.parse(draft.document);
      await tx.query('SELECT id FROM "Merchant" WHERE id=$1 FOR UPDATE', [
        a.merchantId,
      ]);
      const seq = (
        await tx.query(
          'SELECT COALESCE(max(sequence),0)+1 n FROM "PolicyVersion" WHERE "merchantId"=$1',
          [a.merchantId],
        )
      ).rows[0].n;
      const p = (
        await tx.query(
          'INSERT INTO "PolicyVersion"("merchantId",sequence,"contentHash","effectiveFrom") VALUES($1,$2,$3,now()) RETURNING *',
          [a.merchantId, seq, hashPayload(doc)],
        )
      ).rows[0];
      for (const clause of doc.clauses)
        await tx.query(
          'INSERT INTO "PolicyClause"("merchantId","policyVersionId","clauseKey",text,"rulesJson") VALUES($1,$2,$3,$4,$5)',
          [
            a.merchantId,
            p.id,
            clause.clauseKey,
            clause.text,
            JSON.stringify(clause.rules),
          ],
        );
      await tx.query(
        'UPDATE "PolicyVersion" SET "publishedAt"=now() WHERE id=$1',
        [p.id],
      );
      await tx.query(
        'UPDATE "Merchant" SET "activePolicyVersionId"=$2 WHERE id=$1',
        [a.merchantId, p.id],
      );
      await tx.query(
        'UPDATE "PolicyDraft" SET "publishedVersionId"=$2,version=version+1 WHERE id=$1',
        [id, p.id],
      );
      await tx.query(
        'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType","actorId",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'PolicyVersion\',$2,\'USER\',$3,\'POLICY_PUBLISHED\',\'INTERNAL\',$4,$5)',
        [
          a.merchantId,
          p.id,
          a.userId,
          randomUUID(),
          JSON.stringify({ sequence: seq }),
        ],
      );
      return p;
    });
  }
}
