import { it, expect } from 'vitest';
import {
  recommendationCandidates,
  chooseRecommendation,
} from './recommendations.js';
const input = {
  legacy: false,
  eligible: true,
  allowedRemedies: ['HELP', 'REPLACEMENT', 'PARTIAL_REFUND', 'FULL_REFUND'],
  maxPartialRefundBps: 5000,
  potentialRefundCapMinor: '3000',
  requiredEvidenceTypes: ['TEXT'],
  availableEvidenceTypes: ['TEXT'],
  omissions: false,
  current: true,
  gross: 10000n,
  refunded: 1000n,
  external: 1000n,
  reserved: 2000n,
};
it('bounds all nonbinding candidates by remaining balance, policy amount and basis points', () => {
  const r = recommendationCandidates(input);
  expect(r.remainingMinor).toBe('6000');
  expect(
    r.candidates
      .filter((c) => c.kind === 'PARTIAL_REFUND')
      .map((c) => c.amountMinor),
  ).toEqual(['1500', '3000']);
  expect(r.candidates.some((c) => c.kind === 'FULL_REFUND')).toBe(false);
  for (const c of r.candidates.filter((c) => c.amountMinor !== null))
    expect(BigInt(c.amountMinor!)).toBeLessThanOrEqual(3000n);
});
it('legacy, missing evidence, omissions and uncertain outcomes cannot gain a financial remedy through human revision', () => {
  for (const extra of [
    { legacy: true },
    { availableEvidenceTypes: [] },
    { omissions: true },
    { current: false },
    { eligible: false },
  ]) {
    const r = recommendationCandidates({ ...input, ...extra });
    expect(r.candidates.map((c) => c.kind)).toEqual([
      'REQUEST_MORE_INFORMATION',
      'ESCALATE_TO_HUMAN',
    ]);
  }
  const r = recommendationCandidates(input),
    financial = r.candidates.find((c) => c.amountMinor !== null)!;
  expect(() => chooseRecommendation(r.candidates, financial.id, true)).toThrow(
    'UNCERTAINTY_REQUIRES_REVIEW',
  );
  expect(() => chooseRecommendation(r.candidates, 'invented', false)).toThrow(
    'INVALID_CANDIDATE',
  );
});
