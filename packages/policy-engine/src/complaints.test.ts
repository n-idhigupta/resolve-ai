import { describe, it, expect } from 'vitest';
import {
  complaintPolicy,
  caseTransition,
  repeatComplaintAllowed,
} from './complaints.js';
describe('complaint boundaries', () => {
  it('explicitly reviews legacy policy without inventing entitlements', () => {
    expect(
      complaintPolicy([], 'OTHER', new Date(), new Date(), 10000n),
    ).toMatchObject({
      legacy: true,
      eligible: true,
      reviewReasons: ['LEGACY_PURCHASE_POLICY_MANUAL_REVIEW'],
    });
  });
  it('requires permitted transitions and nonempty reasons', () => {
    expect(caseTransition('OPEN', 'BEGIN_REVIEW', true, '')).toBe(
      'INVESTIGATING',
    );
    expect(
      caseTransition(
        'INVESTIGATING',
        'REQUEST_INFORMATION',
        true,
        'Receipt please',
      ),
    ).toBe('AWAITING_CUSTOMER');
    expect(
      caseTransition('AWAITING_CUSTOMER', 'RESPOND', false, 'Attached'),
    ).toBe('INVESTIGATING');
    expect(caseTransition('OPEN', 'WITHDRAW', false, 'No longer needed')).toBe(
      'CLOSED_WITHOUT_AGREEMENT',
    );
    expect(() => caseTransition('OPEN', 'BEGIN_REVIEW', false, '')).toThrow();
    expect(() =>
      caseTransition('CLOSED_WITHOUT_AGREEMENT', 'RESPOND', false, 'x'),
    ).toThrow();
  });
  it('caps lifetime complaints and applies a 24h cooldown', () => {
    const now = new Date();
    expect(repeatComplaintAllowed(3, null, now)).toBe(false);
    expect(repeatComplaintAllowed(1, now, now)).toBe(false);
    expect(
      repeatComplaintAllowed(1, new Date(now.getTime() - 86400000), now),
    ).toBe(true);
  });
});

it('uses inclusive purchase-window bounds and intersects deterministic restrictions', () => {
  const rules = {
    schemaVersion: 1,
    applicableReasons: ['DAMAGED'],
    allowedRemedies: ['HELP', 'PARTIAL_REFUND'],
    complaintWindowDays: 30,
    requiredEvidenceTypes: ['IMAGE'],
    maxPartialRefundBps: 5000,
    maxRefundMinor: '2500',
    manualReviewThresholdMinor: '1000',
    mandatoryHumanReview: false,
    replacementAllowed: false,
  };
  const start = new Date('2026-01-01T00:00:00Z'),
    deadline = new Date(start.getTime() + 30 * 86400000);
  const result = complaintPolicy(
    [rules, { ...rules, maxPartialRefundBps: 2500, maxRefundMinor: '1000' }],
    'DAMAGED',
    start,
    deadline,
    10000n,
  );
  expect(result).toMatchObject({
    eligible: true,
    maxPartialRefundBps: 2500,
    potentialRefundCapMinor: '1000',
    reviewReasons: ['MANUAL_REVIEW_REQUIRED'],
  });
  expect(
    complaintPolicy(
      [rules],
      'DAMAGED',
      start,
      new Date(deadline.getTime() + 1),
      10000n,
    ).eligible,
  ).toBe(false);
  expect(complaintPolicy([rules], 'OTHER', start, start, 10000n).eligible).toBe(
    false,
  );
});
