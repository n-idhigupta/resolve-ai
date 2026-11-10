import type { RefundEngine } from './refunds.js';
import { PayPalError } from '@resolveai/paypal-client';
import { z } from 'zod';
import type { WebhookHeaders } from '@resolveai/paypal-client';
import { decryptReceipt, PaymentError } from './db.js';
import { PaymentStore, audit, type Operation } from './store.js';
import { PaymentEngine, verifyOrder, verifyCapture } from './engine.js';
export type PaymentJob = {
  schemaVersion: 1;
  merchantId: string;
  kind: 'operation' | 'webhook' | 'refund';
  id: string;
};
export const paymentJobSchema = z.strictObject({
  schemaVersion: z.literal(1),
  merchantId: z.uuid(),
  kind: z.enum(['operation', 'webhook', 'refund']),
  id: z.uuid(),
});
export type Enqueue = (job: PaymentJob, jobId: string) => Promise<unknown>;
export class PaymentDelivery {
  constructor(
    readonly store: PaymentStore,
    readonly engine: PaymentEngine,
    readonly enqueue: Enqueue,
    readonly encryptionKey: string,
    readonly refunds?: RefundEngine,
  ) {}
  async tick() {
    const accounts = await this.store.accounts();
    for (const merchantId of new Set(accounts.map((a) => a.merchantId))) {
      const leased = await this.store.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query<{
              id: string;
              aggregateId: string;
              eventType: string;
              attempts: number;
              leaseOwner: string;
            }>(
              `WITH due AS (SELECT id FROM "OutboxEvent" WHERE "merchantId"=$1 AND "deliveredAt" IS NULL AND "availableAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) AND "eventType" IN ('payment.create','payment.capture','payment.webhook','payment.refund') ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 25) UPDATE "OutboxEvent" o SET "leaseOwner"=gen_random_uuid(),"leaseUntil"=now()+interval '30 seconds',attempts=attempts+1 FROM due WHERE o.id=due.id RETURNING o.*`,
              [merchantId],
            )
          ).rows,
      );
      for (const event of leased) {
        try {
          await this.enqueue(
            {
              schemaVersion: 1,
              merchantId,
              kind:
                event.eventType === 'payment.refund'
                  ? 'refund'
                  : event.eventType === 'payment.webhook'
                    ? 'webhook'
                    : 'operation',
              id: event.aggregateId,
            },
            'event-' + event.id + '-' + event.attempts,
          );
          await this.store.db.transaction(merchantId, null, (tx) =>
            tx.query(
              `UPDATE "OutboxEvent" SET "deliveredAt"=now(),"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=$1 AND "leaseOwner"=$2`,
              [event.id, event.leaseOwner],
            ),
          );
        } catch {
          await this.store.db.transaction(merchantId, null, (tx) =>
            tx.query(
              `UPDATE "OutboxEvent" SET "leaseUntil"=NULL,"leaseOwner"=NULL,"availableAt"=now()+interval '5 seconds' WHERE id=$1 AND "leaseOwner"=$2`,
              [event.id, event.leaseOwner],
            ),
          );
        }
      }
      const due = await this.store.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query<{ id: string; version: number }>(
              `SELECT c.id,c.version FROM "CheckoutOperation" c JOIN "Order" o ON o.id=c."orderId" WHERE c."merchantId"=$1 AND o."paymentState" NOT IN ('CAPTURED','FAILED','CANCELLED') AND (c."leaseUntil" IS NULL OR c."leaseUntil"<now()) AND ((c."nextAttemptAt"<=now()) OR (c.state='IN_FLIGHT' AND c."leaseUntil"<now())) AND c.state IN ('READY','IN_FLIGHT','UNKNOWN','PENDING','COMPLETED') ORDER BY c."createdAt" LIMIT 25`,
              [merchantId],
            )
          ).rows,
      );
      for (const op of due)
        await this.enqueue(
          { schemaVersion: 1, merchantId, kind: 'operation', id: op.id },
          'recover-' +
            op.id +
            '-' +
            op.version +
            '-' +
            Math.floor(Date.now() / 15000),
        );
      if (this.refunds) {
        const refunds = await this.store.db.transaction(
          merchantId,
          null,
          async (tx) =>
            (
              await tx.query(
                'SELECT r.id,r.version FROM "RefundOperation" r JOIN "Settlement" s ON s."refundOperationId"=r.id JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE r."merchantId"=$1 AND a."refundMode"<>\'disabled\' AND r.state IN (\'READY\',\'IN_FLIGHT\',\'UNKNOWN\',\'PENDING\') AND ((r."nextAttemptAt"<=now() AND (r."leaseUntil" IS NULL OR r."leaseUntil"<now())) OR (r.state=\'IN_FLIGHT\' AND r."leaseUntil"<now())) LIMIT 25',
                [merchantId],
              )
            ).rows,
        );
        for (const r of refunds)
          await this.enqueue(
            { schemaVersion: 1, merchantId, kind: 'refund', id: r.id },
            'refund-recover-' +
              r.id +
              '-' +
              r.version +
              '-' +
              Math.floor(Date.now() / 15000),
          );
      }
      const receipts = await this.store.db.transaction(
        merchantId,
        null,
        async (tx) =>
          (
            await tx.query<{ id: string }>(
              `SELECT r.id FROM "WebhookReceipt" r JOIN "WebhookInbox" i ON i.id=r."inboxId" WHERE r."merchantId"=$1 AND (r."verificationStatus"='UNVERIFIED' OR (r."verificationStatus"='VERIFIED' AND i."processingStatus"<>'PROCESSED')) ORDER BY r."receivedAt" LIMIT 25`,
              [merchantId],
            )
          ).rows,
      );
      for (const r of receipts)
        await this.enqueue(
          { schemaVersion: 1, merchantId, kind: 'webhook', id: r.id },
          'receipt-' + r.id + '-' + Math.floor(Date.now() / 60000),
        );
    }
  }
  async process(input: unknown) {
    const job = paymentJobSchema.parse(input);
    if (job.kind === 'refund') {
      if (!this.refunds) throw Error('Refund processor unavailable');
      await this.refunds.run(job.merchantId, job.id);
      return;
    }
    if (job.kind === 'operation') await this.engine.run(job.merchantId, job.id);
    else await this.webhook(job.merchantId, job.id);
  }
  async webhook(merchantId: string, id: string) {
    const data = await this.store.db.transaction(
      merchantId,
      null,
      async (tx) => {
        const receipt = (
          await tx.query(
            `SELECT r.*,i."accountId",i."providerEventId",i."processingStatus" FROM "WebhookReceipt" r JOIN "WebhookInbox" i ON i.id=r."inboxId" WHERE r.id=$1 AND r."merchantId"=$2`,
            [id, merchantId],
          )
        ).rows[0];
        if (!receipt) return null;
        const account = (
          await tx.query(`SELECT * FROM "PaymentAccount" WHERE id=$1`, [
            receipt.accountId,
          ])
        ).rows[0];
        return account ? { receipt, account } : null;
      },
    );
    if (!data) return;
    const { receipt, account } = data;
    if (
      receipt.verificationStatus === 'REJECTED' ||
      (receipt.verificationStatus === 'VERIFIED' &&
        receipt.processingStatus === 'PROCESSED')
    )
      return;
    if (!account.webhookId)
      throw new PaymentError(
        503,
        'WEBHOOK_NOT_CONFIGURED',
        'Webhook ID missing',
      );
    const raw = decryptReceipt(
        receipt.originalPayloadEncryptedRef,
        this.encryptionKey,
      ),
      client = this.engine.provider(account);
    if (receipt.verificationStatus !== 'VERIFIED') {
      let valid: boolean;
      try {
        valid = await client.verifyWebhook(
          raw,
          receipt.redactedHeaders as WebhookHeaders,
          account.webhookId,
        );
      } catch (error) {
        if (
          error instanceof PayPalError &&
          !error.retryable &&
          !error.code.startsWith('OAUTH_') &&
          [400, 422].includes(error.status)
        )
          valid = false;
        else throw error;
      }
      await this.store.db.transaction(merchantId, null, async (tx) => {
        await tx.query(
          `UPDATE "WebhookReceipt" SET "verificationStatus"=$2::"VerificationState" WHERE id=$1`,
          [id, valid ? 'VERIFIED' : 'REJECTED'],
        );
        if (valid)
          await tx.query(
            `UPDATE "WebhookInbox" SET "verificationStatus"='VERIFIED' WHERE id=$1`,
            [receipt.inboxId],
          );
      });
      if (!valid) return;
    }
    const event = z
      .object({
        id: z.string(),
        event_type: z.string(),
        resource: z.object({ id: z.string() }).passthrough(),
      })
      .parse(JSON.parse(raw));
    if (event.id !== receipt.providerEventId)
      throw new PaymentError(
        409,
        'EVENT_ID_MISMATCH',
        'Stored event ID changed',
      );
    const allowed = [
      'CHECKOUT.ORDER.APPROVED',
      'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
      'PAYMENT.CAPTURE.COMPLETED',
      'PAYMENT.CAPTURE.PENDING',
      'PAYMENT.CAPTURE.DECLINED',
      'PAYMENT.CAPTURE.REVERSED',
    ];
    if (
      [
        'PAYMENT.CAPTURE.REFUNDED',
        'PAYMENT.REFUND.PENDING',
        'PAYMENT.REFUND.FAILED',
      ].includes(event.event_type)
    ) {
      if (!this.refunds) throw Error('Refund reconciliation unavailable');
      if (
        !(await this.refunds.observeWebhook(
          merchantId,
          account.id,
          event.resource.id,
        ))
      )
        throw Error('Unmatched refund requires review');
    }
    if (allowed.includes(event.event_type)) {
      let providerOrderId: string | undefined;
      if (event.event_type.startsWith('CHECKOUT.'))
        providerOrderId = event.resource.id;
      else {
        const capture = await client.getCapture(event.resource.id);
        providerOrderId = capture.supplementary_data?.related_ids.order_id;
        if (!providerOrderId)
          providerOrderId = await this.store.db.transaction(
            merchantId,
            null,
            async (tx) =>
              (
                await tx.query<{ providerOrderId: string }>(
                  'SELECT "providerOrderId" FROM "CheckoutOperation" WHERE "accountId"=$1 AND "providerCaptureId"=$2',
                  [account.id, capture.id],
                )
              ).rows[0]?.providerOrderId,
          );
      }
      if (!providerOrderId)
        throw new PaymentError(
          409,
          'UNMATCHED_PROVIDER_RESOURCE',
          'Cannot establish capture/order relationship',
        );
      const remote = await client.getOrder(providerOrderId);
      const internalId = remote.purchase_units?.[0]?.custom_id;
      if (!internalId || !z.uuid().safeParse(internalId).success)
        throw new PaymentError(
          409,
          'UNMATCHED_PROVIDER_RESOURCE',
          'No valid internal order association',
        );
      const context = await this.store.db.transaction(
        merchantId,
        null,
        async (tx) => {
          const order = (
            await tx.query(
              'SELECT * FROM "Order" WHERE id=$1 AND "merchantId"=$2',
              [internalId, merchantId],
            )
          ).rows[0];
          const create = (
            await tx.query<Operation>(
              `SELECT * FROM "CheckoutOperation" WHERE "orderId"=$1 AND "accountId"=$2 AND kind='CREATE'`,
              [internalId, account.id],
            )
          ).rows[0];
          return order && create ? { order, create } : null;
        },
      );
      if (!context)
        throw new PaymentError(
          409,
          'UNMATCHED_PROVIDER_RESOURCE',
          'No durable checkout intent',
        );
      verifyOrder(remote, context.order, account, providerOrderId);
      if (
        context.create.providerOrderId &&
        context.create.providerOrderId !== providerOrderId
      )
        throw new PaymentError(
          409,
          'PROVIDER_ORDER_MISMATCH',
          'Conflicting provider order',
        );
      await this.store.db.transaction(merchantId, null, (tx) =>
        tx.query(
          `UPDATE "CheckoutOperation" SET "providerOrderId"=$2,"nextAttemptAt"=now(),version=version+1 WHERE id=$1 AND "providerOrderId" IS NULL`,
          [context.create.id, providerOrderId],
        ),
      );
      if (
        context.order.status === 'PAID' &&
        event.event_type.startsWith('PAYMENT.CAPTURE.')
      ) {
        const capture = await client.getCapture(event.resource.id);
        verifyCapture(capture, remote, context.order, account);
        if (capture.status !== 'COMPLETED')
          await this.store.db.transaction(merchantId, null, async (tx) => {
            const changed = await tx.query(
              `UPDATE "Capture" SET "reconciliationStatus"='FROZEN',"providerStatus"=$3,"discrepancyJson"=$4,version=version+1 WHERE "merchantId"=$1 AND "providerCaptureId"=$2 AND "reconciliationStatus"<>'FROZEN'`,
              [
                merchantId,
                capture.id,
                capture.status,
                JSON.stringify({ reason: 'PROVIDER_SETTLEMENT_CHANGED' }),
              ],
            );
            if (changed.rowCount) {
              await tx.query(
                `UPDATE "Order" SET "paymentState"='RECONCILIATION_REQUIRED',version=version+1 WHERE id=$1`,
                [internalId],
              );
              await audit(
                tx,
                merchantId,
                context.create.id,
                'SETTLEMENT_REQUIRES_REVIEW',
                null,
                { captureId: capture.id, status: capture.status },
              );
            }
          });
      } else {
        await this.engine.run(merchantId, context.create.id);
        const captureOp = await this.store.db.transaction(
          merchantId,
          null,
          async (tx) =>
            (
              await tx.query<Operation>(
                `SELECT * FROM "CheckoutOperation" WHERE "orderId"=$1 AND kind='CAPTURE'`,
                [internalId],
              )
            ).rows[0],
        );
        if (captureOp) await this.engine.run(merchantId, captureOp.id);
      }
    }
    await this.store.db.transaction(merchantId, null, async (tx) => {
      const changed = await tx.query(
        `UPDATE "WebhookInbox" SET "processingStatus"='PROCESSED',attempts=attempts+1 WHERE id=$1 AND "processingStatus"<>'PROCESSED'`,
        [receipt.inboxId],
      );
      if (changed.rowCount)
        await tx.query(
          `INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType",action,visibility,"correlationId","redactedMetadata") VALUES($1,'WebhookInbox',$2,'WORKER','VERIFIED_WEBHOOK_PROCESSED','INTERNAL',$3,$4)`,
          [
            merchantId,
            receipt.inboxId,
            id,
            JSON.stringify({ eventId: event.id, eventType: event.event_type }),
          ],
        );
    });
  }
}
