import type { NegotiationInput } from '@resolveai/shared';
import { refundableRemaining } from './index.js';
export function validateNegotiation(
  input: NegotiationInput,
  policy: {
    legacy?: boolean;
    eligible?: boolean;
    allowedRemedies?: string[];
    requiredEvidenceTypes?: string[];
    maxPartialRefundBps?: number | null;
    potentialRefundCapMinor?: string | null;
  },
  capture: {
    gross: bigint;
    completed: bigint;
    external: bigint;
    reserved: bigint;
  },
  types: string[],
  now = new Date(),
) {
  const expiry = Date.parse(input.expiresAt);
  if (expiry <= now.getTime() || expiry > now.getTime() + 7 * 86400000)
    throw Error('INVALID_OFFER_EXPIRY');
  if (input.kind === 'REPLACEMENT' && Date.parse(input.shipBy) <= now.getTime())
    throw Error('INVALID_SHIP_DATE');
  if (['REQUEST_EVIDENCE', 'ESCALATION'].includes(input.kind))
    return {
      engineVersion: 'negotiation-v1',
      nonbinding: true,
      financialExecution: false,
    };
  if (
    policy.legacy ||
    !policy.eligible ||
    !policy.allowedRemedies?.includes(input.kind)
  )
    throw Error('POLICY_REMEDY_NOT_PERMITTED');
  if (policy.requiredEvidenceTypes?.some((t) => !types.includes(t)))
    throw Error('POLICY_EVIDENCE_REQUIRED');
  const remaining = refundableRemaining(capture);
  if ('amountMinor' in input) {
    const amount = BigInt(input.amountMinor),
      cap =
        policy.potentialRefundCapMinor === null ||
        policy.potentialRefundCapMinor === undefined
          ? remaining
          : BigInt(policy.potentialRefundCapMinor);
    if (amount > remaining || amount > cap)
      throw Error('POLICY_AMOUNT_EXCEEDED');
    if (input.kind === 'FULL_REFUND' && amount !== remaining)
      throw Error('FULL_REFUND_MUST_EQUAL_REMAINING');
    if (
      input.kind === 'PARTIAL_REFUND' &&
      (amount >= remaining ||
        amount >
          (remaining * BigInt(policy.maxPartialRefundBps ?? 10000)) / 10000n)
    )
      throw Error('POLICY_PARTIAL_LIMIT');
  }
  return {
    engineVersion: 'negotiation-v1',
    remainingMinor: remaining.toString(),
    nonbinding: true,
    financialExecution: false,
  };
}
