import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  PayPalError,
  refundSchema,
  type RefundProvider,
  type PayPalRefund,
  type RefundRequest,
} from '@resolveai/paypal-client';
import { decimalToMinor } from '@resolveai/shared';
import { PaymentDatabase, PaymentError, hashPayload, type Tx } from './db.js';
import { verifyCapture } from './engine.js';
import type { Account } from './store.js';
export type RefundFactory = (
  account: Account & { refundMode?: string },
) => RefundProvider;
export function verifyRefund(
  r: PayPalRefund,
  op: QueryResultRow,
  cap: QueryResultRow,
) {
  const up = r.links?.find((l) => l.rel === 'up');
  let matches = false;
  if (up) {
    try {
      const u = new URL(up.href);
      matches =
        [
          'api-m.sandbox.paypal.com',
          'api.sandbox.paypal.com',
          'api-m.paypal.com',
        ].includes(u.hostname) &&
        u.protocol === 'https:' &&
        u.pathname === '/v2/payments/captures/' + cap.providerCaptureId &&
        !u.search &&
        !u.hash &&
        !u.username &&
        !u.password;
    } catch {
      /* invalid link is not proof */
    }
  }
  if (
    r.id !== op.providerRefundId ||
    r.invoice_id !== op.id ||
    r.amount.currency_code !== op.currency ||
    decimalToMinor(r.amount.value).toString() !== String(op.amountMinor) ||
    !matches
  )
    throw new PaymentError(
      409,
      'REFUND_IDENTITY_MISMATCH',
      'Refund does not match authorized capture and intent',
    );
}
export class RefundEngine {
  constructor(
    readonly db: PaymentDatabase,
    readonly provider: RefundFactory,
    readonly allowedModes: string[] = ['mock', 'paypal'],
  ) {}
  async timeline(
    tx: Tx,
    m: string,
    c: string,
    action: string,
    metadata: unknown,
  ) {
    await tx.query(
      'INSERT INTO "CaseTimelineEvent"("merchantId","caseId",action,visibility,metadata) VALUES($1,$2,$3,\'CUSTOMER\',$4)',
      [m, c, action, JSON.stringify(metadata)],
    );
    await tx.query(
      'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'Case\',$2,\'WORKER\',$3,\'INTERNAL\',$4,$5)',
      [m, c, action, randomUUID(), JSON.stringify(metadata)],
    );
  }
  async claim(m: string, id: string) {
    return this.db.transaction(m, null, async (tx) => {
      const op = (
        await tx.query(
          'SELECT r.*,s."caseId",s.id AS "settlementId" FROM "RefundOperation" r JOIN "Settlement" s ON s."refundOperationId"=r.id WHERE r.id=$1 AND r."merchantId"=$2 FOR UPDATE OF r',
          [id, m],
        )
      ).rows[0];
      if (
        !op ||
        ['COMPLETED', 'FAILED'].includes(op.state) ||
        (op.leaseUntil && new Date(op.leaseUntil).getTime() > Date.now())
      )
        return null;
      const cap = (
          await tx.query('SELECT * FROM "Capture" WHERE id=$1', [op.captureId])
        ).rows[0],
        account = (
          await tx.query('SELECT * FROM "PaymentAccount" WHERE id=$1', [
            op.accountId,
          ])
        ).rows[0],
        order = (
          await tx.query('SELECT * FROM "Order" WHERE id=$1', [op.orderId])
        ).rows[0];
      if (
        !cap ||
        !order ||
        !account?.enabled ||
        !this.allowedModes.includes(account.refundMode)
      )
        return null;
      if (
        account.refundMode === 'mock' &&
        !cap.providerCaptureId.startsWith('SYNTHETIC_')
      )
        throw Error('Mock refund requires synthetic capture');
      const lease = randomUUID();
      await tx.query(
        'UPDATE "RefundOperation" SET state=\'IN_FLIGHT\',"leaseOwner"=$2,"leaseUntil"=now()+interval \'90 seconds\',"attemptCount"="attemptCount"+1,version=version+1 WHERE id=$1',
        [id, lease],
      );
      await tx.query(
        'INSERT INTO "PaymentAttempt"("merchantId","refundOperationId","attemptNo","requestHash","startedAt") VALUES($1,$2,$3,$4,now())',
        [m, id, op.attemptCount + 1, op.requestHash],
      );
      return {
        op: { ...op, leaseOwner: lease, attemptCount: op.attemptCount + 1 },
        cap,
        account,
        order,
      };
    });
  }
  async run(m: string, id: string) {
    const ctx = await this.claim(m, id);
    if (!ctx) return;
    const { op, cap, account, order } = ctx;
    let observed = op.providerRefundId as string | null;
    try {
      if (
        hashPayload({
          captureId: cap.providerCaptureId,
          accountId: cap.accountId,
          payload: op.requestPayload,
        }) !== op.requestHash
      )
        throw new PaymentError(
          409,
          'REFUND_HASH_MISMATCH',
          'Immutable refund payload mismatch',
        );
      const provider = this.provider(account);
      if (!observed && !op.firstDispatchAt) {
        const beforeCapture = await provider.getCapture(cap.providerCaptureId),
          beforeOrder = await provider.getOrder(cap.providerOrderId);
        verifyCapture(
          beforeCapture,
          beforeOrder,
          {
            id: order.id,
            amountMinor: String(cap.grossMinor),
            currency: cap.currency,
          },
          account,
        );
        if (
          !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(beforeCapture.status) ||
          (beforeCapture.status === 'PARTIALLY_REFUNDED' &&
            BigInt(cap.refundedMinor) === 0n)
        )
          throw new PaymentError(
            409,
            'EXTERNAL_REFUND_REVIEW_REQUIRED',
            'Provider capture has an unaccounted settlement change',
          );

        if (
          cap.reconciliationStatus !== 'CURRENT' ||
          !cap.verifiedAt ||
          BigInt(cap.reservedMinor) < BigInt(op.amountMinor)
        )
          throw new PaymentError(
            409,
            'REFUND_REVIEW_REQUIRED',
            'Capture is not eligible',
          );
        const dispatched = await this.db.transaction(m, null, async (tx) => {
          const eligible = (
            await tx.query('SELECT refund_authorization_current($1) ok', [
              op.id,
            ])
          ).rows[0]?.ok;
          if (!eligible) return false;
          return !!(
            await tx.query(
              'UPDATE "RefundOperation" SET "firstDispatchAt"=now() WHERE id=$1 AND "leaseOwner"=$2 AND "firstDispatchAt" IS NULL RETURNING id',
              [id, op.leaseOwner],
            )
          ).rows[0];
        });
        if (!dispatched)
          throw new PaymentError(
            409,
            'REFUND_AUTHORIZATION_CHANGED',
            'Authorization no longer current',
          );
        const r = await provider.refundCapture(
          cap.providerCaptureId,
          op.requestPayload as RefundRequest,
          op.providerRequestId,
        );
        observed = r.id;
        await this.db.transaction(m, null, (tx) =>
          tx.query(
            'UPDATE "RefundOperation" SET "providerRefundId"=$3 WHERE id=$1 AND "leaseOwner"=$2 AND "providerRefundId" IS NULL',
            [id, op.leaseOwner, observed],
          ),
        );
      }
      if (!observed) {
        await this.finish(ctx, 'UNKNOWN', 'OUTCOME_UNKNOWN_NO_REFUND_ID');
        return;
      }
      const refund = refundSchema.parse(await provider.getRefund(observed));
      verifyRefund(refund, { ...op, providerRefundId: observed }, cap);
      const remoteCapture = await provider.getCapture(cap.providerCaptureId),
        remoteOrder = await provider.getOrder(cap.providerOrderId);
      verifyCapture(
        remoteCapture,
        remoteOrder,
        {
          id: order.id,
          amountMinor: String(cap.grossMinor),
          currency: cap.currency,
        },
        account,
      );
      await this.finish(
        ctx,
        refund.status === 'COMPLETED'
          ? 'COMPLETED'
          : ['FAILED', 'CANCELLED'].includes(refund.status)
            ? 'FAILED'
            : 'PENDING',
        null,
        observed,
      );
    } catch (e) {
      const definitive =
        e instanceof PayPalError &&
        !e.uncertain &&
        [400, 403, 404, 422].includes(e.status) &&
        !observed &&
        !op.firstDispatchAt;
      await this.finish(
        ctx,
        definitive ? 'FAILED' : 'UNKNOWN',
        e instanceof PayPalError || e instanceof PaymentError
          ? e.code
          : e && typeof e === 'object' && 'code' in e && e.code === '42501'
            ? 'REFUND_DB_PERMISSION_DENIED'
            : e &&
                typeof e === 'object' &&
                'code' in e &&
                typeof e.code === 'string' &&
                /^[A-Z0-9]{5}$/.test(e.code)
              ? 'REFUND_PERSISTENCE_ERROR'
              : 'REFUND_UNCERTAIN',
        observed,
      );
    }
  }
  async finish(
    ctx: NonNullable<Awaited<ReturnType<RefundEngine['claim']>>>,
    state: string,
    error: string | null,
    observed?: string | null,
  ) {
    const { op, cap, account } = ctx;
    await this.db.transaction(op.merchantId, null, async (tx) => {
      await tx.query('SELECT id FROM "Capture" WHERE id=$1 FOR UPDATE', [
        cap.id,
      ]);
      await tx.query('SELECT id FROM "Case" WHERE id=$1 FOR UPDATE', [
        op.caseId,
      ]);
      await tx.query('SELECT id FROM "Proposal" WHERE id=$1 FOR UPDATE', [
        op.proposalId,
      ]);
      const current = (
        await tx.query(
          'SELECT * FROM "RefundOperation" WHERE id=$1 FOR UPDATE',
          [op.id],
        )
      ).rows[0];
      if (
        !current ||
        current.leaseOwner !== op.leaseOwner ||
        ['COMPLETED', 'FAILED'].includes(current.state)
      )
        return;
      const terminal = ['COMPLETED', 'FAILED'].includes(state);
      await tx.query(
        'UPDATE "RefundOperation" SET state=$2::"OperationState","providerRefundId"=COALESCE("providerRefundId",$3),"lastErrorCode"=$4,"completedAt"=CASE WHEN $2=\'COMPLETED\' THEN now() ELSE NULL END,"leaseOwner"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=CASE WHEN $5 OR "attemptCount">=10 THEN NULL ELSE now()+interval \'60 seconds\' END,version=version+1 WHERE id=$1',
        [op.id, state, observed ?? null, error, terminal],
      );
      await tx.query(
        'UPDATE "PaymentAttempt" SET "finishedAt"=now(),"transportOutcome"=$3 WHERE "refundOperationId"=$1 AND "attemptNo"=$2',
        [op.id, op.attemptCount, state],
      );
      if (terminal)
        await tx.query(
          'UPDATE "Capture" SET "reservedMinor"="reservedMinor"-$2::bigint,"refundedMinor"="refundedMinor"+CASE WHEN $3 THEN $2::bigint ELSE 0 END,version=version+1 WHERE id=$1',
          [cap.id, op.amountMinor, state === 'COMPLETED'],
        );
      await tx.query(
        'UPDATE "Settlement" SET state=$2,version=version+1 WHERE id=$1',
        [
          op.settlementId,
          state === 'COMPLETED'
            ? 'COMPLETED'
            : state === 'FAILED'
              ? 'FAILED'
              : state === 'UNKNOWN'
                ? 'REVIEW_REQUIRED'
                : 'AUTHORIZED',
        ],
      );
      if (state === 'COMPLETED') {
        await tx.query(
          'UPDATE "Proposal" SET status=\'FULFILLED\',"rowVersion"="rowVersion"+1,"completedAt"=now() WHERE id=$1',
          [op.proposalId],
        );
        await tx.query(
          'UPDATE "Case" SET status=\'RESOLVED\',"resolvedAt"=now(),version=version+1,"updatedAt"=now() WHERE id=$1',
          [op.caseId],
        );
      } else if (state === 'FAILED')
        await tx.query(
          'UPDATE "Case" SET status=\'ESCALATED\',version=version+1 WHERE id=$1',
          [op.caseId],
        );
      if (state !== current.state || terminal)
        await this.timeline(tx, op.merchantId, op.caseId, 'REFUND_' + state, {
          operationId: op.id,
          amountMinor: String(op.amountMinor),
          currency: op.currency,
          providerRefundId: observed ?? current.providerRefundId,
          mode: account.refundMode,
          code: error,
        });
    });
  }
  async observeWebhook(m: string, accountId: string, refundId: string) {
    const account = await this.db.transaction(
      m,
      null,
      async (tx) =>
        (
          await tx.query('SELECT * FROM "PaymentAccount" WHERE id=$1', [
            accountId,
          ])
        ).rows[0],
    );
    if (!account || account.refundMode === 'disabled') return false;
    const refund = refundSchema.parse(
      await this.provider(account).getRefund(refundId),
    );
    const result = await this.db.transaction(m, null, async (tx) => {
      const op = (
        await tx.query(
          'SELECT r.*,c."providerCaptureId" FROM "RefundOperation" r JOIN "Capture" c ON c.id=r."captureId" WHERE r."accountId"=$1 AND (r."providerRefundId"=$2 OR r.id::text=$3) FOR UPDATE OF r',
          [accountId, refund.id, refund.invoice_id ?? ''],
        )
      ).rows[0];
      if (!op) return null;
      verifyRefund(refund, { ...op, providerRefundId: refund.id }, op);
      if (op.providerRefundId && op.providerRefundId !== refund.id)
        throw new PaymentError(
          409,
          'REFUND_IDENTITY_MISMATCH',
          'Conflicting refund identity',
        );
      await tx.query(
        'UPDATE "RefundOperation" SET "providerRefundId"=COALESCE("providerRefundId",$2),"nextAttemptAt"=now() WHERE id=$1',
        [op.id, refund.id],
      );
      return op.id as string;
    });
    if (result) {
      await this.run(m, result);
      return true;
    }
    const link = refund.links?.find((l) => l.rel === 'up');
    if (!link) return false;
    let captureId: string;
    try {
      const u = new URL(link.href);
      if (
        u.protocol !== 'https:' ||
        ![
          'api-m.sandbox.paypal.com',
          'api.sandbox.paypal.com',
          'api-m.paypal.com',
        ].includes(u.hostname) ||
        !/^\/v2\/payments\/captures\/[A-Za-z0-9_-]{1,64}$/.test(u.pathname) ||
        u.search ||
        u.hash ||
        u.username ||
        u.password
      )
        return false;
      captureId = u.pathname.split('/').at(-1)!;
    } catch {
      return false;
    }
    const cap = await this.db.transaction(
      m,
      null,
      async (tx) =>
        (
          await tx.query(
            'SELECT * FROM "Capture" WHERE "accountId"=$1 AND "providerCaptureId"=$2',
            [accountId, captureId],
          )
        ).rows[0],
    );
    if (!cap) return false;
    const provider = this.provider(account),
      remoteCapture = await provider.getCapture(captureId),
      remoteOrder = await provider.getOrder(cap.providerOrderId);
    verifyCapture(
      remoteCapture,
      remoteOrder,
      {
        id: cap.orderId,
        amountMinor: String(cap.grossMinor),
        currency: cap.currency,
      },
      account,
    );
    if (
      refund.amount.currency_code !== cap.currency ||
      decimalToMinor(refund.amount.value) > BigInt(cap.grossMinor)
    )
      throw new PaymentError(
        409,
        'EXTERNAL_REFUND_MISMATCH',
        'External refund is inconsistent',
      );
    await this.db.transaction(m, null, async (tx) => {
      const changed = await tx.query(
        'UPDATE "Capture" SET "reconciliationStatus"=\'FROZEN\',"discrepancyJson"=$3,version=version+1 WHERE id=$1 AND "accountId"=$2 AND "reconciliationStatus"<>\'FROZEN\' RETURNING id',
        [
          cap.id,
          accountId,
          JSON.stringify({
            reason: 'UNTRACKED_EXTERNAL_REFUND',
            providerRefundId: refund.id,
          }),
        ],
      );
      if (changed.rowCount)
        await tx.query(
          'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'Capture\',$2,\'WORKER\',\'EXTERNAL_REFUND_REQUIRES_REVIEW\',\'INTERNAL\',$3,$4)',
          [
            m,
            cap.id,
            randomUUID(),
            JSON.stringify({ providerRefundId: refund.id }),
          ],
        );
    });
    return true;
  }
}
export function mockRefundProvider(
  db: PaymentDatabase,
  account: Account,
): RefundProvider {
  const load = async (id: string) =>
    db.transaction(
      account.merchantId,
      null,
      async (tx) =>
        (
          await tx.query(
            'SELECT r.*,c."providerCaptureId",c."providerOrderId",c."grossMinor" FROM "RefundOperation" r JOIN "Capture" c ON c.id=r."captureId" WHERE r."accountId"=$1 AND (r."providerRefundId"=$2 OR \'MOCK_\'||replace(r.id::text,\'-\',\'\')=$2)',
            [account.id, id],
          )
        ).rows[0],
    );
  return {
    refundCapture: async (captureId, payload, key) => {
      if (!captureId.startsWith('SYNTHETIC_') || !key)
        throw Error('Synthetic mock only');
      const r = await load('MOCK_' + payload.invoice_id.replaceAll('-', ''));
      if (!r || r.providerCaptureId !== captureId)
        throw Error('Unknown mock intent');
      return {
        id: 'MOCK_' + r.id.replaceAll('-', ''),
        status: 'COMPLETED',
        amount: payload.amount,
        invoice_id: r.id,
        links: [
          {
            rel: 'up',
            href:
              'https://api-m.sandbox.paypal.com/v2/payments/captures/' +
              captureId,
          },
        ],
      };
    },
    getRefund: async (id) => {
      const r = await load(id);
      if (!r) throw Error('Unknown mock refund');
      return {
        id,
        status: 'COMPLETED',
        amount: r.requestPayload.amount,
        invoice_id: r.id,
        links: [
          {
            rel: 'up',
            href:
              'https://api-m.sandbox.paypal.com/v2/payments/captures/' +
              r.providerCaptureId,
          },
        ],
      };
    },
    getCapture: async (id) => {
      const c = await db.transaction(
        account.merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'SELECT * FROM "Capture" WHERE "accountId"=$1 AND "providerCaptureId"=$2',
              [account.id, id],
            )
          ).rows[0],
      );
      if (!c || !id.startsWith('SYNTHETIC_'))
        throw Error('Synthetic mock only');
      return {
        id,
        status: 'COMPLETED',
        amount: {
          value:
            (BigInt(c.grossMinor) / 100n).toString() +
            '.' +
            (BigInt(c.grossMinor) % 100n).toString().padStart(2, '0'),
          currency_code: c.currency,
        },
        final_capture: true,
      };
    },
    getOrder: async (id) => {
      const c = await db.transaction(
        account.merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'SELECT * FROM "Capture" WHERE "accountId"=$1 AND "providerOrderId"=$2',
              [account.id, id],
            )
          ).rows[0],
      );
      if (!c || !c.providerCaptureId.startsWith('SYNTHETIC_'))
        throw Error('Synthetic mock only');
      return {
        id,
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: c.orderId,
            custom_id: c.orderId,
            payee: { merchant_id: account.providerMerchantId },
            amount: {
              value:
                (BigInt(c.grossMinor) / 100n).toString() +
                '.' +
                (BigInt(c.grossMinor) % 100n).toString().padStart(2, '0'),
              currency_code: c.currency,
            },
            payments: {
              captures: [
                {
                  id: c.providerCaptureId,
                  status: 'COMPLETED',
                  amount: {
                    value:
                      (BigInt(c.grossMinor) / 100n).toString() +
                      '.' +
                      (BigInt(c.grossMinor) % 100n).toString().padStart(2, '0'),
                    currency_code: c.currency,
                  },
                },
              ],
            },
          },
        ],
      };
    },
  };
}
export class RefundDelivery {
  constructor(
    readonly engine: RefundEngine,
    readonly enqueue: (
      merchantId: string,
      id: string,
      jobId: string,
    ) => Promise<unknown>,
    readonly modes: string[] = ['mock'],
  ) {}
  async tick() {
    const accounts = await this.engine.db.rows<{ merchantId: string }>(
      'SELECT "merchantId" FROM "PaymentAccount" WHERE enabled AND "workerRoleName"=current_user AND "refundMode"=ANY($1::text[])',
      [this.modes],
    );
    for (const { merchantId } of accounts) {
      const events = await this.engine.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'WITH due AS (SELECT id FROM "OutboxEvent" WHERE "merchantId"=$1 AND "eventType"=\'payment.refund\' AND EXISTS(SELECT 1 FROM "RefundOperation" r JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE r.id="OutboxEvent"."aggregateId" AND a."refundMode"=ANY($2::text[])) AND "deliveredAt" IS NULL AND "availableAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) FOR UPDATE SKIP LOCKED LIMIT 25) UPDATE "OutboxEvent" o SET "leaseOwner"=gen_random_uuid(),"leaseUntil"=now()+interval \'30 seconds\',attempts=attempts+1 FROM due WHERE o.id=due.id RETURNING o.*',
              [merchantId, this.modes],
            )
          ).rows,
      );
      for (const e of events) {
        await this.enqueue(
          merchantId,
          e.aggregateId,
          'refund-event-' + e.id + '-' + e.attempts,
        );
        await this.engine.db.transaction(merchantId, null, (tx) =>
          tx.query(
            'UPDATE "OutboxEvent" SET "deliveredAt"=now(),"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',
            [e.id, e.leaseOwner],
          ),
        );
      }
      const due = await this.engine.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query(
              'SELECT r.id,r.version FROM "RefundOperation" r JOIN "Settlement" s ON s."refundOperationId"=r.id JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE r."merchantId"=$1 AND a."refundMode"=ANY($2::text[]) AND r.state IN (\'READY\',\'UNKNOWN\',\'PENDING\',\'IN_FLIGHT\') AND (("nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now())) OR (r.state=\'IN_FLIGHT\' AND "leaseUntil"<now())) LIMIT 25',
              [merchantId, this.modes],
            )
          ).rows,
      );
      for (const r of due)
        await this.enqueue(
          merchantId,
          r.id,
          'refund-sweep-' +
            r.id +
            '-' +
            r.version +
            '-' +
            Math.floor(Date.now() / 15000),
        );
    }
  }
}
