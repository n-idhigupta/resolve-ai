import { it, expect } from 'vitest';
import {
  refundableRemaining,
  partialCeiling,
  canReserve,
  authorize,
} from './index.js';
it('excludes all committed and reserved amounts', () => {
  expect(
    refundableRemaining({
      gross: 10000n,
      completed: 1000n,
      external: 2000n,
      reserved: 3000n,
    }),
  ).toBe(4000n);
  expect(() =>
    refundableRemaining({
      gross: 1n,
      completed: 0n,
      external: 0n,
      reserved: 2n,
    }),
  ).toThrow();
});
it('rounds partial caps down exactly', () => {
  expect(partialCeiling(101n, 2500)).toBe(25n);
  expect(() => partialCeiling(100n, 10001)).toThrow();
  expect(canReserve(100n, 101n)).toBe(false);
  expect(canReserve(100n, 0n)).toBe(false);
  expect(authorize('AGENT', 'refunds:approve')).toBe(false);
});
