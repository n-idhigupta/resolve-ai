import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  settlementDecisionSchema,
  settlementCancelSchema,
  negotiationInputSchema,
  minorToDecimal,
} from '@resolveai/shared';
import {
  validateNegotiation,
  refundableRemaining,
  canReserve,
} from '@resolveai/policy-engine';
import { hashPayload, type Tx } from '@resolveai/payment-store';
import {
  CaseStore,
  member,
  event,
  replay,
  remember,
  fail,
  type Actor,
} from './cases.js';
import { NegotiationStore } from './negotiation.js';
export class SettlementStore {
  readonly negotiation: NegotiationStore;
  constructor(readonly cases: CaseStore) {
    this.negotiation = new NegotiationStore(cases);
  }
  async list(a: Actor, id: string) {
    return this.cases.tx(a, async (tx) => {
      if (!(await tx.query('SELECT id FROM "Case" WHERE id=$1', [id])).rows[0])
        fail('NOT_FOUND', 404);
      return (
        await tx.query(
          'SELECT s.id,s."proposalId",s."contentHash",s."acceptedProposalVersion",s."acceptedAt",s."authorizedAt",s.state,s.version,(SELECT e.metadata->>\'reference\' FROM "CaseTimelineEvent" e WHERE e."caseId"=s."caseId" AND e.action=\'REPLACEMENT_SHIPPED\' AND e.metadata->>\'settlementId\'=s.id::text ORDER BY e."createdAt" DESC LIMIT 1) AS "shipmentReference",r.id AS "refundOperationId",r.state AS "refundState",r."providerRefundId",r."lastErrorCode",r."amountMinor"::text AS "amountMinor",r.currency,a."refundMode" AS mode FROM "Settlement" s LEFT JOIN "RefundOperation" r ON r.id=s."refundOperationId" LEFT JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE s."caseId"=$1 ORDER BY s."acceptedAt" DESC LIMIT 100',
          [id],
        )
      ).rows;
    });
  }
  async locked(tx: Tx, a: Actor, id: string) {
    // Financial lock order remains Capture -> Case -> Proposal.
    await tx.query(
      'SELECT cap.id FROM "Capture" cap JOIN "Case" c ON c."orderId"=cap."orderId" WHERE c.id=$1 AND c."merchantId"=$2 FOR UPDATE OF cap',
      [id, a.merchantId],
    );
    return this.cases.locked(tx, a, id);
  }
  async validate(tx: Tx, c: QueryResultRow, p: QueryResultRow) {
    const context = await this.negotiation.context(tx, c);
    if (!context.verified || p.contextHash !== context.hash)
      fail('OFFER_STALE');
    if (!['FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT'].includes(p.kind))
      fail('NOT_A_SETTLEMENT', 422);
    if (p.kind === 'REPLACEMENT' && !context.replacementAllowed)
      fail('POLICY_REPLACEMENT_NOT_PERMITTED', 422);
    try {
      validateNegotiation(
        negotiationInputSchema.parse(p.termsJson),
        c.policySnapshot,
        {
          gross: BigInt(context.capture.grossMinor),
          completed: BigInt(context.capture.refundedMinor),
          external: BigInt(context.capture.externalRefundedMinor),
          reserved: BigInt(context.capture.reservedMinor),
        },
        context.types,
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : 'POLICY_INVALID', 422);
    }
    return context;
  }
  async approval(
    tx: Tx,
    a: Actor,
    p: QueryResultRow,
    role: string,
    authenticatedAt: Date,
  ) {
    await tx.query(
      'INSERT INTO "Approval"("merchantId","proposalId","actorUserId","actorRole",decision,"contentHash","policyVersionId","decidedAt","authenticationContext") VALUES($1,$2,$3,$4,\'ACCEPT\',$5,$6,now(),$7)',
      [
        a.merchantId,
        p.id,
        a.userId,
        role,
        p.contentHash,
        p.policyVersionId,
        JSON.stringify({
          authenticatedAt: authenticatedAt.toISOString(),
          proposalVersion: p.rowVersion,
          explicit: true,
        }),
      ],
    );
  }
  async accept(
    a: Actor,
    id: string,
    proposalId: string,
    input: unknown,
    version: number,
    key: string,
    authenticatedAt: Date,
  ) {
    const body = settlementDecisionSchema.parse(input);
    return this.cases.tx(a, async (tx) => {
      const c = await this.locked(tx, a, id);
      if (c.openedBy !== a.userId || (await member(tx, a)))
        fail('FORBIDDEN', 403);
      const p = (
        await tx.query(
          'SELECT * FROM "Proposal" WHERE id=$1 AND "caseId"=$2 FOR UPDATE',
          [proposalId, id],
        )
      ).rows[0];
      if (!p) fail('NOT_FOUND', 404);
      const scope = 'settlement-accept:' + proposalId,
        old = await replay(tx, a, scope, key, body);
      if (old) return old;
      if (c.version !== version || p.rowVersion !== body.proposalVersion)
        fail('STALE_VERSION');
      if (
        p.contentHash !== body.contentHash ||
        c.currentProposalId !== p.id ||
        p.status !== 'OFFERED' ||
        p.authorRole !== 'MERCHANT'
      )
        fail('OFFER_NOT_CURRENT');
      if (!['OPEN', 'INVESTIGATING', 'AWAITING_CUSTOMER'].includes(c.status))
        fail('CASE_CLOSED');
      await this.validate(tx, c, p);
      await this.approval(tx, a, p, 'CUSTOMER', authenticatedAt);
      const result = (
        await tx.query(
          'INSERT INTO "Settlement"("merchantId","caseId","proposalId","contentHash","contextHash","acceptedBy","acceptedProposalVersion") VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,state',
          [
            a.merchantId,
            id,
            p.id,
            p.contentHash,
            p.contextHash,
            a.userId,
            p.rowVersion,
          ],
        )
      ).rows[0];
      await tx.query(
        'UPDATE "Proposal" SET status=\'AGREED\',"rowVersion"="rowVersion"+1 WHERE id=$1',
        [p.id],
      );
      await tx.query(
        'UPDATE "Case" SET version=version+1,"updatedAt"=now() WHERE id=$1',
        [id],
      );
      await event(tx, a, id, 'SETTLEMENT_ACCEPTED', c.status, c.status, {
        settlementId: result.id,
        proposalId: p.id,
        contentHash: p.contentHash,
        proposalVersion: p.rowVersion,
        refundExecuted: false,
      });
      await remember(tx, a, scope, key, body, result);
      return result;
    });
  }
  async authorize(
    a: Actor,
    id: string,
    settlementId: string,
    input: unknown,
    version: number,
    key: string,
    authenticatedAt: Date,
  ) {
    const body = settlementDecisionSchema.parse(input);
    if (
      Date.now() - authenticatedAt.getTime() > 900000 ||
      authenticatedAt.getTime() > Date.now()
    )
      fail('FRESH_AUTHENTICATION_REQUIRED', 403);
    return this.cases.tx(a, async (tx) => {
      const c = await this.locked(tx, a, id),
        role = await member(tx, a);
      if (!role || !['OWNER', 'APPROVER'].includes(role))
        fail('FORBIDDEN', 403);
      const s = (
        await tx.query(
          'SELECT * FROM "Settlement" WHERE id=$1 AND "caseId"=$2 FOR UPDATE',
          [settlementId, id],
        )
      ).rows[0];
      if (!s) fail('NOT_FOUND', 404);
      const p = (
        await tx.query('SELECT * FROM "Proposal" WHERE id=$1 FOR UPDATE', [
          s.proposalId,
        ])
      ).rows[0];
      const scope = 'settlement-authorize:' + s.id,
        old = await replay(tx, a, scope, key, body);
      if (old) return old;
      if (
        s.state !== 'ACCEPTED' ||
        p.status !== 'AGREED' ||
        c.currentProposalId !== p.id
      )
        fail('SETTLEMENT_NOT_CURRENT');
      if (c.version !== version || p.rowVersion !== body.proposalVersion)
        fail('STALE_VERSION');
      if (s.contentHash !== body.contentHash || p.contentHash !== s.contentHash)
        fail('CONTENT_HASH_MISMATCH');
      const context = await this.validate(tx, c, p);
      const approval = (
        await tx.query(
          'SELECT id FROM "Approval" WHERE "proposalId"=$1 AND "actorRole"=\'CUSTOMER\' AND "actorUserId"=$2 AND "contentHash"=$3 AND decision=\'ACCEPT\'',
          [p.id, c.openedBy, p.contentHash],
        )
      ).rows[0];
      if (!approval) fail('CUSTOMER_CONSENT_REQUIRED');
      if (p.kind === 'REPLACEMENT') {
        await this.approval(tx, a, p, 'MERCHANT', authenticatedAt);
        await tx.query(
          'UPDATE "Settlement" SET state=\'FULFILLMENT_PENDING\',"authorizedBy"=$2,"authorizedAt"=now(),version=version+1 WHERE id=$1',
          [s.id, a.userId],
        );
        await tx.query(
          'UPDATE "Case" SET status=\'RESOLUTION_PENDING\',version=version+1 WHERE id=$1',
          [id],
        );
        await event(
          tx,
          a,
          id,
          'REPLACEMENT_AUTHORIZED',
          c.status,
          'RESOLUTION_PENDING',
          { settlementId: s.id, financial: false },
        );
        const result = { id: s.id, state: 'FULFILLMENT_PENDING' };
        await remember(tx, a, scope, key, body, result);
        return result;
      }
      const cap = (
          await tx.query('SELECT * FROM "Capture" WHERE id=$1', [
            context.capture.id,
          ])
        ).rows[0],
        account = (
          await tx.query(
            'SELECT id,enabled,"refundMode" FROM "PaymentAccount" WHERE id=$1',
            [cap.accountId],
          )
        ).rows[0];
      if (process.env.NODE_ENV === 'production')
        fail('FINANCIAL_EXECUTION_NOT_RELEASED', 503);
      if (!account?.enabled || !['mock', 'paypal'].includes(account.refundMode))
        fail('REFUND_EXECUTION_DISABLED', 503);
      if (
        account.refundMode === 'mock' &&
        !cap.providerCaptureId.startsWith('SYNTHETIC_')
      )
        fail('MOCK_CAPTURE_REQUIRED', 403);
      // Real execution is separately gated in its worker; normal settings remain disabled.
      if (
        account.refundMode === 'paypal' &&
        process.env.PAYPAL_REFUNDS_ENABLED !== 'true'
      )
        fail('REFUND_EXECUTION_DISABLED', 503);
      const remaining = refundableRemaining({
        gross: BigInt(cap.grossMinor),
        completed: BigInt(cap.refundedMinor),
        external: BigInt(cap.externalRefundedMinor),
        reserved: BigInt(cap.reservedMinor),
      });
      if (!canReserve(remaining, BigInt(p.amountMinor)))
        fail('INSUFFICIENT_FUNDS');
      await this.approval(tx, a, p, 'MERCHANT', authenticatedAt);
      const opId = randomUUID(),
        payload = {
          amount: {
            currency_code: 'USD',
            value: minorToDecimal(BigInt(p.amountMinor)),
          },
          invoice_id: opId,
        };
      const requestHash = hashPayload({
        captureId: cap.providerCaptureId,
        accountId: cap.accountId,
        payload,
      });
      await tx.query(
        'INSERT INTO "RefundOperation"(id,"merchantId","captureId","proposalId","orderId","accountId","amountMinor",currency,"providerRequestId","requestHash","requestPayload") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          opId,
          a.merchantId,
          cap.id,
          p.id,
          c.orderId,
          cap.accountId,
          p.amountMinor,
          p.currency,
          randomUUID(),
          requestHash,
          JSON.stringify(payload),
        ],
      );
      await tx.query(
        'UPDATE "Capture" SET "reservedMinor"="reservedMinor"+$2::bigint,version=version+1 WHERE id=$1',
        [cap.id, p.amountMinor],
      );
      await tx.query(
        'UPDATE "Settlement" SET state=\'AUTHORIZED\',"authorizedBy"=$2,"authorizedAt"=now(),"refundOperationId"=$3,version=version+1 WHERE id=$1',
        [s.id, a.userId, opId],
      );
      await tx.query(
        'UPDATE "Proposal" SET status=\'EXECUTING\',"rowVersion"="rowVersion"+1 WHERE id=$1',
        [p.id],
      );
      await tx.query(
        'UPDATE "Case" SET status=\'RESOLUTION_PENDING\',version=version+1,"updatedAt"=now() WHERE id=$1',
        [id],
      );
      await tx.query(
        'INSERT INTO "OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES($1,\'RefundOperation\',$2,\'payment.refund\',1,$3,$4)',
        [
          a.merchantId,
          opId,
          JSON.stringify({ operationId: opId }),
          'refund-' + opId,
        ],
      );
      await event(
        tx,
        a,
        id,
        'REFUND_AUTHORIZED_AND_RESERVED',
        c.status,
        'RESOLUTION_PENDING',
        {
          settlementId: s.id,
          refundOperationId: opId,
          mode: account.refundMode,
          amountMinor: p.amountMinor,
        },
      );
      const result = {
        id: s.id,
        state: 'AUTHORIZED',
        refundOperationId: opId,
        mode: account.refundMode,
      };
      await remember(tx, a, scope, key, body, result);
      return result;
    });
  }
  async cancel(
    a: Actor,
    id: string,
    settlementId: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = settlementCancelSchema.parse(input);
    return this.cases.tx(a, async (tx) => {
      const c = await this.locked(tx, a, id),
        s = (
          await tx.query(
            'SELECT * FROM "Settlement" WHERE id=$1 AND "caseId"=$2 FOR UPDATE',
            [settlementId, id],
          )
        ).rows[0];
      if (!s) fail('NOT_FOUND', 404);
      const scope = 'settlement-cancel:' + s.id,
        old = await replay(tx, a, scope, key, body);
      if (old) return old;
      if (c.version !== version) fail('STALE_VERSION');
      if (s.state !== 'ACCEPTED') fail('SETTLEMENT_ALREADY_AUTHORIZED');
      await tx.query(
        'UPDATE "Settlement" SET state=\'CANCELLED\',version=version+1 WHERE id=$1',
        [s.id],
      );
      await tx.query(
        'UPDATE "Proposal" SET status=\'WITHDRAWN\',"rowVersion"="rowVersion"+1 WHERE id=$1',
        [s.proposalId],
      );
      await tx.query(
        'UPDATE "Case" SET "currentProposalId"=NULL,version=version+1 WHERE id=$1',
        [id],
      );
      await event(tx, a, id, 'SETTLEMENT_CANCELLED', c.status, c.status, {
        settlementId: s.id,
        reason: body.reason,
      });
      const result = { id: s.id, state: 'CANCELLED' };
      await remember(tx, a, scope, key, body, result);
      return result;
    });
  }

  async fulfillment(
    a: Actor,
    id: string,
    settlementId: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = z
      .strictObject({
        action: z.enum(['SHIP', 'RECEIVE']),
        reference: z.string().trim().max(200).default(''),
      })
      .parse(input);
    return this.cases.tx(a, async (tx) => {
      const c = await this.locked(tx, a, id),
        role = await member(tx, a),
        s = (
          await tx.query(
            'SELECT * FROM "Settlement" WHERE id=$1 AND "caseId"=$2 FOR UPDATE',
            [settlementId, id],
          )
        ).rows[0];
      if (!s) fail('NOT_FOUND', 404);
      const scope = 'settlement-fulfill:' + s.id,
        old = await replay(tx, a, scope, key, body);
      if (old) return old;
      if (c.version !== version) fail('STALE_VERSION');
      if (s.state !== 'FULFILLMENT_PENDING') fail('FULFILLMENT_NOT_PENDING');
      const p = (
        await tx.query('SELECT * FROM "Proposal" WHERE id=$1 FOR UPDATE', [
          s.proposalId,
        ])
      ).rows[0];
      if (p.kind !== 'REPLACEMENT') fail('NOT_A_REPLACEMENT');
      if (body.action === 'SHIP') {
        if (!role) fail('FORBIDDEN', 403);
        if (!body.reference) fail('SHIPMENT_REFERENCE_REQUIRED', 422);
        await event(tx, a, id, 'REPLACEMENT_SHIPPED', c.status, c.status, {
          settlementId: s.id,
          reference: body.reference,
          manualAcknowledgment: true,
        });
      } else {
        if (role || s.acceptedBy !== a.userId) fail('FORBIDDEN', 403);
        if (
          !(
            await tx.query(
              'SELECT id FROM "CaseTimelineEvent" WHERE "caseId"=$1 AND action=\'REPLACEMENT_SHIPPED\' AND metadata->>\'settlementId\'=$2',
              [id, s.id],
            )
          ).rows[0]
        )
          fail('SHIPMENT_NOT_RECORDED');
        await tx.query(
          'UPDATE "Settlement" SET state=\'COMPLETED\',version=version+1 WHERE id=$1',
          [s.id],
        );
        await tx.query(
          'UPDATE "Proposal" SET status=\'FULFILLED\',"rowVersion"="rowVersion"+1,"completedAt"=now() WHERE id=$1',
          [p.id],
        );
        await tx.query(
          'UPDATE "Case" SET status=\'RESOLVED\',"resolvedAt"=now() WHERE id=$1',
          [id],
        );
        await event(tx, a, id, 'REPLACEMENT_RECEIVED', c.status, 'RESOLVED', {
          settlementId: s.id,
          financial: false,
          manualAcknowledgment: true,
        });
      }
      await tx.query(
        'UPDATE "Case" SET version=version+1,"updatedAt"=now() WHERE id=$1',
        [id],
      );
      const result = {
        id: s.id,
        state: body.action === 'RECEIVE' ? 'COMPLETED' : 'FULFILLMENT_PENDING',
      };
      await remember(tx, a, scope, key, body, result);
      return result;
    });
  }
}
