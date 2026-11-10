import { it, expect } from 'vitest';
import { negotiationInputSchema } from '@resolveai/shared';
import { validateNegotiation } from './negotiation.js';
const policy = {
  legacy: false,
  eligible: true,
  allowedRemedies: ['FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT'],
  requiredEvidenceTypes: ['TEXT'],
  maxPartialRefundBps: 5000,
  potentialRefundCapMinor: '8000',
};
const balance = {
  gross: 10000n,
  completed: 1000n,
  external: 0n,
  reserved: 1000n,
};
const now = new Date('2026-11-10T00:00:00Z');
const body = {
  kind: 'PARTIAL_REFUND' as const,
  amountMinor: '4000',
  currency: 'USD' as const,
  message: 'Manual merchant suggestion.',
  expiresAt: '2026-11-11T00:00:00Z',
};
it('validates exact integer policy ceilings against remaining funds', () => {
  expect(
    validateNegotiation(body, policy, balance, ['TEXT'], now),
  ).toMatchObject({ remainingMinor: '8000', financialExecution: false });
  expect(() =>
    validateNegotiation(
      { ...body, amountMinor: '4001' },
      policy,
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow('POLICY_PARTIAL_LIMIT');
  expect(() =>
    validateNegotiation(
      { ...body, kind: 'FULL_REFUND', amountMinor: '7999' },
      policy,
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow('FULL_REFUND_MUST_EQUAL_REMAINING');
  expect(() =>
    validateNegotiation(
      { ...body, amountMinor: '9000' },
      policy,
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow('POLICY_AMOUNT_EXCEEDED');
});
it('fails closed for legacy, missing policy permission and missing clean evidence', () => {
  expect(() =>
    validateNegotiation(
      body,
      { ...policy, legacy: true },
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow('POLICY_REMEDY_NOT_PERMITTED');
  expect(() => validateNegotiation(body, {}, balance, ['TEXT'], now)).toThrow(
    'POLICY_REMEDY_NOT_PERMITTED',
  );
  expect(() => validateNegotiation(body, policy, balance, [], now)).toThrow(
    'POLICY_EVIDENCE_REQUIRED',
  );
  expect(
    validateNegotiation(
      {
        kind: 'ESCALATION',
        message: 'Needs manual review',
        expiresAt: body.expiresAt,
      },
      { legacy: true },
      balance,
      [],
      now,
    ),
  ).toMatchObject({ financialExecution: false });
});
it('bounds expiry and rejects untrusted execution fields and malformed money', () => {
  expect(() =>
    validateNegotiation(
      { ...body, expiresAt: '2026-11-10T00:00:00Z' },
      policy,
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow('INVALID_OFFER_EXPIRY');
  expect(() =>
    validateNegotiation(
      { ...body, expiresAt: '2026-11-18T00:00:00Z' },
      policy,
      balance,
      ['TEXT'],
      now,
    ),
  ).toThrow();
  for (const amountMinor of ['-1', '0', '1.5', '1000000000000'])
    expect(
      negotiationInputSchema.safeParse({ ...body, amountMinor }).success,
    ).toBe(false);
  expect(
    negotiationInputSchema.safeParse({
      ...body,
      captureId: 'client-controlled',
    }).success,
  ).toBe(false);
});
