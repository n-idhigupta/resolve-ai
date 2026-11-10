import { describe, it, expect } from 'vitest';
import {
  decimalToMinor,
  minorToDecimal,
  moneySchema,
  MAX_MINOR,
  hasPermission,
} from './index.js';
describe('money', () => {
  it('converts exactly without floats', () => {
    expect(decimalToMinor('100.01')).toBe(10001n);
    expect(minorToDecimal(1n)).toBe('0.01');
    expect(decimalToMinor(minorToDecimal(MAX_MINOR))).toBe(MAX_MINOR);
  });
  it.each(['-1', '1e3', 'NaN', '01', '1.001', '1.', ' 1'])(
    'rejects %s',
    (v) => {
      expect(() => decimalToMinor(v)).toThrow();
    },
  );
  it('rejects unsupported currency/numeric minor/overflow', () => {
    for (const v of [
      { minor: '1', currency: 'EUR' },
      { minor: 1, currency: 'USD' },
      { minor: (MAX_MINOR + 1n).toString(), currency: 'USD' },
    ])
      expect(moneySchema.safeParse(v).success).toBe(false);
  });
  it('support cannot approve money', () => {
    expect(hasPermission('AGENT', 'refunds:approve')).toBe(false);
    expect(hasPermission('OWNER', 'refunds:approve')).toBe(true);
  });
});
