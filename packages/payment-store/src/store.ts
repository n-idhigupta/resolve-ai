import { randomUUID } from 'node:crypto';
import {
  minorToDecimal,
  MAX_MINOR,
  canTransitionPayment,
  paymentStateSchema,
} from '@resolveai/shared';
import type {
  CreateOrderRequest,
  WebhookHeaders,
} from '@resolveai/paypal-client';
import {
  PaymentDatabase,
  PaymentError,
  hashPayload,
  encryptReceipt,
  type Tx,
} from './db.js';
export type Account = {
  refundMode?: string;
  id: string;
  merchantId: string;
  providerMerchantId: string;
  webhookId: string | null;
  accountKey: string;
  environment: string;
  enabled: boolean;
  workerRoleName: string | null;
};
export type Operation = {
  id: string;
  merchantId: string;
  orderId: string;
  accountId: string;
  kind: 'CREATE' | 'CAPTURE';
  requestId: string;
  requestHash: string;
  requestPayload:
    | CreateOrderRequest
    | { providerOrderId: string; body: Record<string, never> };
  requestedBy: string;
  providerOrderId: string | null;
  providerCaptureId: string | null;
  providerStatus: string | null;
  approvalUrl: string | null;
  state: string;
  attemptCount: number;
  postAttempts: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  firstAttemptAt: Date | null;
  retryUntil: Date | null;
  nextAttemptAt: Date | null;
  lastErrorCode: string | null;
  version: number;
};
export type IntentInput = {
  merchantId: string;
  orderId: string;
  userId: string;
  key: string;
  version: number;
  providerOrderId?: string;
};
export async function audit(
  tx: Tx,
  merchantId: string,
  id: string,
  action: string,
  actorId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await tx.query(
    `INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType","actorId",action,visibility,"correlationId","redactedMetadata") VALUES($1,'CheckoutOperation',$2::uuid,$3,$4,$5,'INTERNAL',$2::text,$6)`,
    [
      merchantId,
      id,
      actorId ? 'USER' : 'WORKER',
      actorId,
      action,
      JSON.stringify(metadata),
    ],
  );
}
export async function outbox(
  tx: Tx,
  merchantId: string,
  id: string,
  type: string,
  dedupe: string,
) {
  await tx.query(
    `INSERT INTO "OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES($1,'CheckoutOperation',$2,$3,1,$4,$5) ON CONFLICT("merchantId","dedupeKey") DO NOTHING`,
    [merchantId, id, type, JSON.stringify({ operationId: id }), dedupe],
  );
}
export class PaymentStore {
  constructor(readonly db: PaymentDatabase) {}
  async requestIntent(input: IntentInput, kind: 'CREATE' | 'CAPTURE') {
    return this.db.transaction(input.merchantId, input.userId, async (tx) => {
      const order = (
        await tx.query(
          `SELECT * FROM "Order" WHERE id=$1 AND "merchantId"=$2 AND "customerUserId"=$3 FOR UPDATE`,
          [input.orderId, input.merchantId, input.userId],
        )
      ).rows[0];
      if (!order) throw new PaymentError(404, 'NOT_FOUND', 'Order not found');
      const bodyHash = hashPayload({
        kind,
        orderId: input.orderId,
        providerOrderId: input.providerOrderId ?? null,
      });
      const scope = kind + ':' + input.orderId;
      const replay = (
        await tx.query(
          `SELECT * FROM "IdempotencyRecord" WHERE "merchantId"=$1 AND "actorId"=$2 AND "routeScope"=$3 AND key=$4`,
          [input.merchantId, input.userId, scope, input.key],
        )
      ).rows[0];
      if (replay) {
        if (replay.requestHash !== bodyHash)
          throw new PaymentError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key has different input',
          );
        return (
          await tx.query<Operation>(
            'SELECT * FROM "CheckoutOperation" WHERE id=$1',
            [replay.operationId],
          )
        ).rows[0]!;
      }
      if (order.status === 'PAID' || order.status === 'CANCELLED')
        throw new PaymentError(
          409,
          'ORDER_NOT_PAYABLE',
          'Order is already paid or cancelled',
        );
      const merchant = (
        await tx.query('SELECT status FROM "Merchant" WHERE id=$1', [
          input.merchantId,
        ])
      ).rows[0];
      if (merchant?.status !== 'ACTIVE')
        throw new PaymentError(
          409,
          'MERCHANT_UNAVAILABLE',
          'Merchant cannot accept payments',
        );
      let operation = (
        await tx.query<Operation>(
          `SELECT * FROM "CheckoutOperation" WHERE "merchantId"=$1 AND "orderId"=$2 AND kind=$3`,
          [input.merchantId, input.orderId, kind],
        )
      ).rows[0];
      if (kind === 'CAPTURE') {
        const created = (
          await tx.query<Operation>(
            `SELECT * FROM "CheckoutOperation" WHERE "merchantId"=$1 AND "orderId"=$2 AND kind='CREATE'`,
            [input.merchantId, input.orderId],
          )
        ).rows[0];
        if (
          !created?.providerOrderId ||
          created.providerOrderId !== input.providerOrderId
        )
          throw new PaymentError(
            409,
            'PROVIDER_ORDER_MISMATCH',
            'Provider order is not associated with this order',
          );
      }
      if (!operation) {
        if (order.version !== input.version)
          throw new PaymentError(
            409,
            'STALE_VERSION',
            'Order changed; refresh before checkout',
          );
        const accounts = (
          await tx.query<Account>(
            `SELECT * FROM "PaymentAccount" WHERE "merchantId"=$1 AND enabled AND environment='sandbox'`,
            [input.merchantId],
          )
        ).rows;
        if (accounts.length !== 1)
          throw new PaymentError(
            503,
            'PAYPAL_NOT_CONFIGURED',
            'Exactly one configured Sandbox seller is required',
          );
        const account = accounts[0]!;
        const items = (
          await tx.query(
            `SELECT * FROM "OrderItem" WHERE "merchantId"=$1 AND "orderId"=$2 ORDER BY id`,
            [input.merchantId, input.orderId],
          )
        ).rows;
        const total = items.reduce(
          (sum: bigint, item) =>
            sum +
            BigInt(item.quantity) * BigInt(item.unitMinor) +
            BigInt(item.taxMinor) +
            BigInt(item.shippingMinor),
          0n,
        );
        if (
          items.length === 0 ||
          total <= 0n ||
          total > MAX_MINOR ||
          total !== BigInt(order.amountMinor) ||
          order.currency !== 'USD' ||
          items.some((i) => i.currency !== 'USD')
        )
          throw new PaymentError(
            422,
            'INVALID_ORDER_TOTAL',
            'Order item totals or currency are invalid',
          );
        const payload: Operation['requestPayload'] =
          kind === 'CREATE'
            ? {
                intent: 'CAPTURE',
                purchase_units: [
                  {
                    reference_id: input.orderId,
                    custom_id: input.orderId,
                    payee: { merchant_id: account.providerMerchantId },
                    amount: {
                      value: minorToDecimal(total),
                      currency_code: 'USD',
                    },
                  },
                ],
              }
            : { providerOrderId: input.providerOrderId!, body: {} };
        operation = (
          await tx.query<Operation>(
            `INSERT INTO "CheckoutOperation"("merchantId","orderId","accountId",kind,"requestId","requestHash","requestPayload","requestedBy","providerOrderId","nextAttemptAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING *`,
            [
              input.merchantId,
              input.orderId,
              account.id,
              kind,
              randomUUID(),
              hashPayload(payload),
              JSON.stringify(payload),
              input.userId,
              kind === 'CAPTURE' ? input.providerOrderId : null,
            ],
          )
        ).rows[0]!;
        await outbox(
          tx,
          input.merchantId,
          operation.id,
          kind === 'CREATE' ? 'payment.create' : 'payment.capture',
          'intent-' + operation.id,
        );
        await audit(
          tx,
          input.merchantId,
          operation.id,
          'PAYMENT_INTENT_CREATED',
          input.userId,
          { kind },
        );
      }
      await tx.query(
        `INSERT INTO "IdempotencyRecord"("merchantId","actorId","routeScope",key,"requestHash","operationId","expiresAt") VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day')`,
        [
          input.merchantId,
          input.userId,
          scope,
          input.key,
          bodyHash,
          operation.id,
        ],
      );
      return operation;
    });
  }
  async accounts() {
    return this.db.rows<Account>(
      'SELECT * FROM "PaymentAccount" WHERE enabled ORDER BY id',
    );
  }
  async claim(merchantId: string, id: string) {
    return this.db.transaction(merchantId, null, async (tx) => {
      const lease = randomUUID();
      const row = (
        await tx.query<Operation>(
          `UPDATE "CheckoutOperation" c SET state=CASE WHEN kind='CREATE' AND state='COMPLETED' THEN 'COMPLETED'::"OperationState" ELSE 'IN_FLIGHT'::"OperationState" END,"leaseOwner"=$3,"leaseUntil"=now()+interval '90 seconds',version=version+1,"attemptCount"="attemptCount"+1 WHERE c.id=$1 AND c."merchantId"=$2 AND (c."leaseUntil" IS NULL OR c."leaseUntil"<now()) AND (state<>'UNKNOWN' OR "nextAttemptAt" IS NOT NULL) AND (state IN ('READY','IN_FLIGHT','PENDING','UNKNOWN') OR (kind='CREATE' AND state='COMPLETED' AND EXISTS(SELECT 1 FROM "Order" o WHERE o.id=c."orderId" AND o."paymentState" NOT IN ('CAPTURED','FAILED','CANCELLED')))) RETURNING *`,
          [id, merchantId, lease],
        )
      ).rows[0];
      return row;
    });
  }
  async load(merchantId: string, id: string) {
    return this.db.transaction(merchantId, null, async (tx) => {
      const op = (
        await tx.query<Operation>(
          'SELECT * FROM "CheckoutOperation" WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!op) return null;
      const account = (
        await tx.query<Account>('SELECT * FROM "PaymentAccount" WHERE id=$1', [
          op.accountId,
        ])
      ).rows[0];
      const order = (
        await tx.query('SELECT * FROM "Order" WHERE id=$1', [op.orderId])
      ).rows[0];
      const merchant = (
        await tx.query('SELECT status FROM "Merchant" WHERE id=$1', [
          merchantId,
        ])
      ).rows[0];
      return account && order && merchant
        ? { op, account, order, merchant }
        : null;
    });
  }
  async rememberProviderOrder(op: Operation, providerOrderId: string) {
    return this.db.transaction(op.merchantId, null, async (tx) => {
      const result = await tx.query(
        `UPDATE "CheckoutOperation" SET "providerOrderId"=$3,version=version+1 WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">now() AND ("providerOrderId" IS NULL OR "providerOrderId"=$3) RETURNING id`,
        [op.id, op.leaseOwner, providerOrderId],
      );
      if (result.rowCount)
        await audit(
          tx,
          op.merchantId,
          op.id,
          'PROVIDER_ORDER_ID_OBSERVED',
          null,
          { providerOrderId },
        );
      return Boolean(result.rowCount);
    });
  }
  async beforePost(op: Operation) {
    return this.db.transaction(op.merchantId, null, async (tx) => {
      const row = (
        await tx.query<Operation>(
          `UPDATE "CheckoutOperation" SET "postAttempts"="postAttempts"+1,"firstAttemptAt"=coalesce("firstAttemptAt",now()),"retryUntil"=coalesce("retryUntil",now()+interval '21300 seconds') WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">now() AND "postAttempts"<5 AND ("retryUntil" IS NULL OR "retryUntil">now()) RETURNING *`,
          [op.id, op.leaseOwner],
        )
      ).rows[0];
      if (!row)
        throw new PaymentError(
          409,
          'RETRY_WINDOW_CLOSED',
          'Mutation retry window or lease is closed',
        );
      await tx.query(
        `INSERT INTO "PaymentAttempt"("merchantId","checkoutOperationId","attemptNo","requestHash","startedAt","transportOutcome") VALUES($1,$2,$3,$4,now(),'SENDING')`,
        [op.merchantId, op.id, op.attemptCount, op.requestHash],
      );
      return row;
    });
  }
  async update(
    op: Operation,
    values: {
      state: string;
      paymentState: string;
      providerOrderId?: string;
      providerCaptureId?: string;
      providerStatus?: string;
      approvalUrl?: string;
      errorCode?: string;
      nextMs?: number | null;
      action: string;
    },
  ) {
    return this.db.transaction(op.merchantId, null, async (tx) => {
      const locked = (
        await tx.query(
          `SELECT id,"paymentState" FROM "Order" WHERE id=$1 FOR UPDATE`,
          [op.orderId],
        )
      ).rows[0];
      if (!locked) return false;
      const changed = await tx.query(
        `UPDATE "CheckoutOperation" SET state=$3::"OperationState","providerOrderId"=coalesce($4,"providerOrderId"),"providerCaptureId"=coalesce($5,"providerCaptureId"),"providerStatus"=coalesce($6,"providerStatus"),"approvalUrl"=coalesce($7,"approvalUrl"),"lastErrorCode"=$8,"nextAttemptAt"=CASE WHEN $9::integer IS NULL THEN NULL ELSE now()+$9*interval '1 millisecond' END,"completedAt"=CASE WHEN $3='COMPLETED' THEN coalesce("completedAt",now()) ELSE "completedAt" END,"leaseOwner"=NULL,"leaseUntil"=NULL,version=version+1 WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">now()`,
        [
          op.id,
          op.leaseOwner,
          values.state,
          values.providerOrderId ?? null,
          values.providerCaptureId ?? null,
          values.providerStatus ?? null,
          values.approvalUrl ?? null,
          values.errorCode ?? null,
          values.nextMs ?? null,
        ],
      );
      if (!changed.rowCount) return false;
      if (
        canTransitionPayment(
          paymentStateSchema.parse(locked.paymentState),
          paymentStateSchema.parse(values.paymentState),
        )
      )
        await tx.query(
          `UPDATE "Order" SET "paymentState"=$2,status=CASE WHEN status='UNPAID' AND $2 NOT IN ('FAILED','CANCELLED') THEN 'PENDING'::"OrderStatus" ELSE status END,version=version+1,"updatedAt"=now() WHERE id=$1 AND "paymentState"<>'CAPTURED' AND ($3='CAPTURE' OR NOT EXISTS(SELECT 1 FROM "CheckoutOperation" c WHERE c."orderId"=$1 AND c.kind='CAPTURE'))`,
          [op.orderId, values.paymentState, op.kind],
        );
      await tx.query(
        `UPDATE "PaymentAttempt" SET "finishedAt"=now(),"transportOutcome"=$3 WHERE "checkoutOperationId"=$1 AND "attemptNo"=$2`,
        [op.id, op.attemptCount, values.errorCode ?? values.state],
      );
      await audit(tx, op.merchantId, op.id, values.action, null, {
        state: values.state,
        providerStatus: values.providerStatus ?? null,
        errorCode: values.errorCode ?? null,
      });
      return true;
    });
  }
  async ensureCapture(create: Operation) {
    return this.db.transaction(create.merchantId, null, async (tx) => {
      await tx.query('SELECT id FROM "Order" WHERE id=$1 FOR UPDATE', [
        create.orderId,
      ]);
      const payload = { providerOrderId: create.providerOrderId!, body: {} };
      const op = (
        await tx.query<Operation>(
          `INSERT INTO "CheckoutOperation"("merchantId","orderId","accountId",kind,"requestId","requestHash","requestPayload","requestedBy","providerOrderId","nextAttemptAt") VALUES($1,$2,$3,'CAPTURE',$4,$5,$6,$7,$8,now()) ON CONFLICT("merchantId","orderId",kind) DO NOTHING RETURNING *`,
          [
            create.merchantId,
            create.orderId,
            create.accountId,
            randomUUID(),
            hashPayload(payload),
            JSON.stringify(payload),
            create.requestedBy,
            create.providerOrderId,
          ],
        )
      ).rows[0];
      if (op) {
        await outbox(
          tx,
          create.merchantId,
          op.id,
          'payment.capture',
          'intent-' + op.id,
        );
        await audit(
          tx,
          create.merchantId,
          op.id,
          'BUYER_APPROVAL_CAPTURE_SCHEDULED',
          null,
        );
      }
      return op;
    });
  }
  async complete(
    op: Operation,
    capture: {
      id: string;
      amountMinor: string;
      currency: string;
      status: string;
      completedAt: Date;
    },
  ) {
    return this.db.transaction(op.merchantId, null, async (tx) => {
      await tx.query('SELECT id FROM "Order" WHERE id=$1 FOR UPDATE', [
        op.orderId,
      ]);
      const current = (
        await tx.query<Operation>(
          'SELECT * FROM "CheckoutOperation" WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">now() FOR UPDATE',
          [op.id, op.leaseOwner],
        )
      ).rows[0];
      if (!current) return false;
      const existing = (
        await tx.query(
          'SELECT * FROM "Capture" WHERE "merchantId"=$1 AND "orderId"=$2',
          [op.merchantId, op.orderId],
        )
      ).rows[0];
      if (
        existing &&
        (existing.providerCaptureId !== capture.id ||
          existing.grossMinor !== capture.amountMinor ||
          existing.accountId !== op.accountId ||
          existing.currency !== capture.currency ||
          existing.providerOrderId !== op.providerOrderId)
      )
        throw new PaymentError(
          409,
          'CAPTURE_CONFLICT',
          'A different capture is already associated',
        );
      if (!existing)
        await tx.query(
          `INSERT INTO "Capture"("merchantId","orderId","accountId","providerCaptureId","providerOrderId","grossMinor",currency,"providerStatus","completedAt","verifiedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [
            op.merchantId,
            op.orderId,
            op.accountId,
            capture.id,
            op.providerOrderId,
            capture.amountMinor,
            capture.currency,
            capture.status,
            capture.completedAt,
          ],
        );
      await tx.query(
        `UPDATE "CheckoutOperation" SET state='COMPLETED',"providerCaptureId"=$3,"providerStatus"='COMPLETED',"lastErrorCode"=NULL,"completedAt"=coalesce("completedAt",now()),"leaseOwner"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=NULL,version=version+1 WHERE id=$1 AND "leaseOwner"=$2`,
        [op.id, op.leaseOwner, capture.id],
      );
      await tx.query(
        `UPDATE "Order" SET status='PAID',"paymentState"='CAPTURED',version=version+1,"updatedAt"=now() WHERE id=$1`,
        [op.orderId],
      );
      await tx.query(
        `UPDATE "PaymentAttempt" SET "finishedAt"=now(),"transportOutcome"='VERIFIED_COMPLETED' WHERE "checkoutOperationId"=$1 AND "attemptNo"=$2`,
        [op.id, op.attemptCount],
      );
      if (!existing)
        await audit(tx, op.merchantId, op.id, 'CAPTURE_VERIFIED', null, {
          captureId: capture.id,
        });
      return true;
    });
  }
  async receipt(
    accountKey: string,
    eventId: string,
    raw: string,
    headers: WebhookHeaders,
    key: string,
  ) {
    const hash = hashPayload({ raw, headers }),
      encrypted = encryptReceipt(raw, key);
    return this.db.rows<{ merchantId: string; receiptId: string }>(
      'SELECT * FROM public.ingest_paypal_receipt($1,$2,$3,$4,$5)',
      [accountKey, eventId, hash, encrypted, JSON.stringify(headers)],
    );
  }
  async payment(merchantId: string, userId: string, orderId: string) {
    return this.db.transaction(merchantId, userId, async (tx) => {
      const order = (
        await tx.query('SELECT * FROM "Order" WHERE id=$1', [orderId])
      ).rows[0];
      if (!order) throw new PaymentError(404, 'NOT_FOUND', 'Order not found');
      const operations = (
        await tx.query<Operation>(
          'SELECT * FROM "CheckoutOperation" WHERE "orderId"=$1 ORDER BY "createdAt"',
          [orderId],
        )
      ).rows;
      const capture =
        (
          await tx.query(
            'SELECT "providerCaptureId","grossMinor",currency,"completedAt","verifiedAt","providerStatus" FROM "Capture" WHERE "orderId"=$1',
            [orderId],
          )
        ).rows[0] ?? null;
      return {
        orderId,
        status: order.paymentState,
        version: order.version,
        money: { minor: order.amountMinor, currency: order.currency },
        operations: operations.map(operationDto),
        capture,
      };
    });
  }
}
export function operationDto(op: Operation) {
  return {
    id: op.id,
    operationId: op.id,
    orderId: op.orderId,
    kind: op.kind,
    state: op.state,
    providerOrderId: op.providerOrderId,
    providerCaptureId: op.providerCaptureId,
    providerStatus: op.providerStatus,
    approvalUrl: op.approvalUrl,
    errorCode: op.lastErrorCode,
    statusUrl: '/api/v1/payment-operations/' + op.id,
  };
}
