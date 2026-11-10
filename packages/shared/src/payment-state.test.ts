import { it, expect } from 'vitest';
import { canTransitionPayment, paymentStateSchema } from './index.js';
it('permits forward payment progress and reconciliation recovery', () => {
  expect(
    canTransitionPayment('AWAITING_BUYER_APPROVAL', 'CAPTURE_PENDING'),
  ).toBe(true);
  expect(
    canTransitionPayment('CAPTURE_PENDING', 'RECONCILIATION_REQUIRED'),
  ).toBe(true);
  expect(canTransitionPayment('RECONCILIATION_REQUIRED', 'CAPTURED')).toBe(
    true,
  );
});
it('rejects stale payment regression and unknown statuses', () => {
  expect(canTransitionPayment('CAPTURED', 'PENDING')).toBe(false);
  expect(
    canTransitionPayment('CAPTURE_PENDING', 'AWAITING_BUYER_APPROVAL'),
  ).toBe(false);
  expect(canTransitionPayment('FAILED', 'PENDING')).toBe(false);
  expect(paymentStateSchema.safeParse('SUCCESS_FROM_BROWSER').success).toBe(
    false,
  );
});
