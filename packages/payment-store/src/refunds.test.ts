import { it, expect } from 'vitest';
import { verifyRefund } from './refunds.js';
const op = {
    id: 'synthetic-intent',
    providerRefundId: 'synthetic-refund',
    amountMinor: '2500',
    currency: 'USD',
  },
  cap = { providerCaptureId: 'SYNTHETIC_CAPTURE' };
const refund = {
  id: 'synthetic-refund',
  status: 'COMPLETED' as const,
  amount: { value: '25.00', currency_code: 'USD' },
  invoice_id: 'synthetic-intent',
  links: [
    {
      rel: 'up',
      href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/SYNTHETIC_CAPTURE',
    },
  ],
};
it('binds refund ID, invoice, integer amount, currency and authoritative capture relationship', () => {
  expect(() => verifyRefund(refund, op, cap)).not.toThrow();
  for (const altered of [
    { ...refund, id: 'another' },
    { ...refund, invoice_id: 'another' },
    { ...refund, amount: { value: '24.00', currency_code: 'USD' } },
    {
      ...refund,
      links: [
        {
          rel: 'up',
          href: 'https://evil.invalid/v2/payments/captures/SYNTHETIC_CAPTURE',
        },
      ],
    },
  ])
    expect(() => verifyRefund(altered, op, cap)).toThrow(
      'Refund does not match',
    );
});
