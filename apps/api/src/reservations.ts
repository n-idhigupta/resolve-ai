import { createHash, randomUUID } from 'node:crypto';
import { hasPermission, idSchema } from '@resolveai/shared';
import { canReserve, refundableRemaining } from '@resolveai/policy-engine';
import { withTenantTransaction, type Database } from './database.js';
import { AppError } from './errors.js';
export async function reserveRefund(
  db: Database,
  actor: { userId: string; authenticatedAt: Date },
  input: {
    merchantId: string;
    captureId: string;
    caseId: string;
    proposalId: string;
  },
  now = new Date(),
) {
  for (const value of Object.values(input)) idSchema.parse(value);
  if (
    now.getTime() - actor.authenticatedAt.getTime() > 900000 ||
    actor.authenticatedAt > now
  )
    throw new AppError(403, 'FORBIDDEN', 'Fresh authentication required');
  return withTenantTransaction(
    db,
    actor,
    input.merchantId,
    async (tx) => {
      const membership = await tx.membership.findFirst({
        where: {
          merchantId: input.merchantId,
          userId: actor.userId,
          active: true,
        },
      });
      if (!membership || !hasPermission(membership.role, 'refunds:approve'))
        throw new AppError(403, 'FORBIDDEN', 'Approver permission required');
      await tx.$queryRaw`SELECT id FROM "Capture" WHERE "merchantId"=${input.merchantId}::uuid AND id=${input.captureId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Case" WHERE "merchantId"=${input.merchantId}::uuid AND id=${input.caseId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Proposal" WHERE "merchantId"=${input.merchantId}::uuid AND id=${input.proposalId}::uuid FOR UPDATE`;
      const capture = await tx.capture.findFirst({
        where: { merchantId: input.merchantId, id: input.captureId },
      });
      const caseRow = await tx.case.findFirst({
        where: { merchantId: input.merchantId, id: input.caseId },
      });
      const proposal = await tx.proposal.findFirst({
        where: { merchantId: input.merchantId, id: input.proposalId },
      });
      if (
        !capture ||
        !caseRow ||
        !proposal ||
        proposal.caseId !== caseRow.id ||
        caseRow.orderId !== capture.orderId ||
        proposal.orderId !== capture.orderId
      )
        throw new AppError(404, 'NOT_FOUND', 'Resource not found');
      const existing = await tx.refundOperation.findUnique({
        where: {
          merchantId_proposalId: {
            merchantId: input.merchantId,
            proposalId: proposal.id,
          },
        },
      });
      if (existing) {
        if (
          existing.captureId !== capture.id ||
          existing.amountMinor !== proposal.amountMinor ||
          existing.currency !== proposal.currency
        )
          throw new AppError(
            409,
            'CONFLICT',
            'Existing reservation has different intent',
          );
        return existing;
      }
      if (
        !['NEGOTIATING', 'RESOLUTION_PENDING'].includes(caseRow.status) ||
        caseRow.currentProposalId !== proposal.id ||
        proposal.status !== 'AGREED' ||
        proposal.expiresAt <= now ||
        proposal.policyVersionId !== caseRow.policyVersionId ||
        capture.providerStatus !== 'COMPLETED' ||
        capture.reconciliationStatus !== 'CURRENT' ||
        proposal.currency !== capture.currency ||
        proposal.amountMinor === null ||
        !['FULL_REFUND', 'PARTIAL_REFUND'].includes(proposal.kind)
      )
        throw new AppError(409, 'CONFLICT', 'Proposal is not eligible');
      const consents = await tx.approval.findMany({
        where: {
          merchantId: input.merchantId,
          proposalId: proposal.id,
          decision: 'ACCEPT',
          contentHash: proposal.contentHash,
          policyVersionId: proposal.policyVersionId,
        },
      });
      const customer = consents.find((c) => c.actorRole === 'CUSTOMER'),
        merchant = consents.find((c) => c.actorRole === 'MERCHANT');
      if (!customer || !merchant)
        throw new AppError(409, 'CONFLICT', 'Both consents required');
      const owned = await tx.order.findFirst({
        where: {
          id: capture.orderId,
          merchantId: input.merchantId,
          customerUserId: customer.actorUserId,
        },
      });
      const approver = await tx.$queryRaw<
        Array<{ eligible: boolean }>
      >`SELECT public.is_active_approver(${input.merchantId}::uuid,${merchant.actorUserId}::uuid) AS eligible`;
      if (!owned || !approver[0]?.eligible)
        throw new AppError(
          409,
          'CONFLICT',
          'Consent actors no longer eligible',
        );
      const remaining = refundableRemaining({
        gross: capture.grossMinor,
        completed: capture.refundedMinor,
        external: capture.externalRefundedMinor,
        reserved: capture.reservedMinor,
      });
      if (
        !canReserve(remaining, proposal.amountMinor) ||
        (proposal.kind === 'FULL_REFUND' &&
          proposal.amountMinor !== remaining) ||
        (proposal.kind === 'PARTIAL_REFUND' &&
          proposal.amountMinor >= remaining)
      )
        throw new AppError(
          409,
          'INSUFFICIENT_FUNDS',
          'Refund exceeds eligible balance',
        );
      const requestHash = createHash('sha256')
        .update(
          [
            capture.accountId,
            capture.id,
            proposal.id,
            proposal.contentHash,
            proposal.amountMinor.toString(),
            proposal.currency,
          ].join('|'),
        )
        .digest('hex');
      const operation = await tx.refundOperation.create({
        data: {
          merchantId: input.merchantId,
          captureId: capture.id,
          proposalId: proposal.id,
          orderId: capture.orderId,
          accountId: capture.accountId,
          amountMinor: proposal.amountMinor,
          currency: proposal.currency,
          providerRequestId: randomUUID(),
          requestHash,
        },
      });
      await tx.capture.update({
        where: { id: capture.id },
        data: {
          reservedMinor: { increment: proposal.amountMinor },
          version: { increment: 1 },
        },
      });
      await tx.auditEvent.create({
        data: {
          merchantId: input.merchantId,
          aggregateType: 'RefundOperation',
          aggregateId: operation.id,
          actorType: 'USER',
          actorId: actor.userId,
          action: 'REFUND_RESERVED_NOT_EXECUTED',
          visibility: 'INTERNAL',
          correlationId: operation.id,
          redactedMetadata: { proposalId: proposal.id },
        },
      });
      return operation;
    },
    true,
  );
}
