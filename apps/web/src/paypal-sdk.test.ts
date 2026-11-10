import { describe, expect, it } from 'vitest';
import { sanitizePayPalError } from './paypal-sdk.js';
describe('PayPal diagnostic redaction', () => {
  it('retains bounded identifiers without raw provider content', () => {
    const result = sanitizePayPalError({
      code: 'NETWORK_ERROR',
      debug_id: 'abc123',
      correlationId: 'corr-123',
      message: 'https://secret.test/?token=secret',
      token: 'secret',
      stack: 'secret',
    });
    expect(result).toEqual({
      code: 'NETWORK_ERROR',
      message: 'PayPal network request failed',
      debugId: 'abc123',
      correlationId: 'corr-123',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('rejects URLs and oversized identifiers', () => {
    expect(
      sanitizePayPalError({
        code: 'https://secret.test',
        debugId: 'a'.repeat(65),
      }),
    ).toEqual({
      code: 'SDK_ERROR',
      message: 'PayPal checkout did not finish',
      debugId: undefined,
      correlationId: undefined,
    });
    expect(sanitizePayPalError(null).code).toBe('SDK_ERROR');
  });
});
