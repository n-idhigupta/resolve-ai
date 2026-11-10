import { refundableRemaining } from './index.js';
export type RecommendationCandidate = {
  id: string;
  kind:
    | 'REQUEST_MORE_INFORMATION'
    | 'NO_FINANCIAL_REMEDY'
    | 'REPLACEMENT'
    | 'PARTIAL_REFUND'
    | 'FULL_REFUND'
    | 'ESCALATE_TO_HUMAN';
  amountMinor: string | null;
  currency: 'USD' | null;
};
export function recommendationCandidates(input: {
  legacy: boolean;
  eligible: boolean;
  allowedRemedies: string[];
  maxPartialRefundBps: number | null;
  potentialRefundCapMinor: string | null;
  requiredEvidenceTypes: string[];
  availableEvidenceTypes: string[];
  omissions: boolean;
  current: boolean;
  gross: bigint;
  refunded: bigint;
  external: bigint;
  reserved: bigint;
}) {
  const rows: Omit<RecommendationCandidate, 'id'>[] = [
    { kind: 'REQUEST_MORE_INFORMATION', amountMinor: null, currency: null },
    { kind: 'ESCALATE_TO_HUMAN', amountMinor: null, currency: null },
  ];
  const remaining = refundableRemaining({
    gross: input.gross,
    completed: input.refunded,
    external: input.external,
    reserved: input.reserved,
  });
  const missing = input.requiredEvidenceTypes.filter(
    (t) => !input.availableEvidenceTypes.includes(t),
  );
  if (
    !input.legacy &&
    input.eligible &&
    input.current &&
    !missing.length &&
    !input.omissions
  ) {
    if (input.allowedRemedies.includes('HELP'))
      rows.push({
        kind: 'NO_FINANCIAL_REMEDY',
        amountMinor: null,
        currency: null,
      });
    if (input.allowedRemedies.includes('REPLACEMENT'))
      rows.push({ kind: 'REPLACEMENT', amountMinor: null, currency: null });
    const max =
      input.potentialRefundCapMinor === null
        ? remaining
        : BigInt(input.potentialRefundCapMinor);
    if (
      input.allowedRemedies.includes('FULL_REFUND') &&
      remaining > 0n &&
      remaining <= max
    )
      rows.push({
        kind: 'FULL_REFUND',
        amountMinor: remaining.toString(),
        currency: 'USD',
      });
    if (input.allowedRemedies.includes('PARTIAL_REFUND')) {
      const ceiling =
        (remaining * BigInt(input.maxPartialRefundBps ?? 10000)) / 10000n;
      const amounts = new Set<string>();
      for (const bps of [2500, 5000, 7500]) {
        let amount = (remaining * BigInt(bps)) / 10000n;
        if (amount > ceiling) amount = ceiling;
        if (amount > max) amount = max;
        if (amount > 0n && amount < remaining) amounts.add(amount.toString());
      }
      for (const amountMinor of amounts)
        rows.push({ kind: 'PARTIAL_REFUND', amountMinor, currency: 'USD' });
    }
  }
  return {
    candidates: rows.map((r, i) => ({ ...r, id: 'C' + i })),
    remainingMinor: remaining.toString(),
    missingEvidenceTypes: missing,
    nonbinding: true,
    requiresHumanReview: true,
  };
}
export function chooseRecommendation(
  candidates: RecommendationCandidate[],
  id: string,
  uncertain: boolean,
) {
  const candidate = candidates.find((c) => c.id === id);
  if (!candidate) throw Error('INVALID_CANDIDATE');
  if (
    uncertain &&
    !['REQUEST_MORE_INFORMATION', 'ESCALATE_TO_HUMAN'].includes(candidate.kind)
  )
    throw Error('UNCERTAINTY_REQUIRES_REVIEW');
  return candidate;
}
