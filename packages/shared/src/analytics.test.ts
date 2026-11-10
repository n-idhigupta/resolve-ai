import { it, expect } from 'vitest';
import { formatMinorTotal, analyticsQuerySchema } from './analytics.js';
it('formats aggregate minor units exactly beyond per-transaction and floating-point limits', () => {
  expect(formatMinorTotal('0')).toBe('0.00');
  expect(formatMinorTotal('2500')).toBe('25.00');
  expect(formatMinorTotal('999999999999999999')).toBe('9999999999999999.99');
  expect(() => formatMinorTotal('-1')).toThrow();
  expect(() => formatMinorTotal('2.5')).toThrow();
});
it('validates analytics filters without accepting executable or unknown fields', () => {
  expect(
    analyticsQuerySchema.safeParse({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z',
    }).success,
  ).toBe(true);
  expect(analyticsQuerySchema.safeParse({ from: 'invalid' }).success).toBe(
    false,
  );
  expect(
    analyticsQuerySchema.safeParse({ merchantId: 'client-override' }).success,
  ).toBe(false);
});
