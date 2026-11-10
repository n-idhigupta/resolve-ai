export interface PayPalSession {
  start(
    options: { presentationMode: 'auto' },
    order: Promise<{ orderId: string }>,
  ): Promise<void>;
  hasReturned(): boolean;
  resume(): Promise<void>;
}
export interface PayPalInstance {
  findEligibleMethods(options: {
    currencyCode: 'USD';
  }): Promise<{ isEligible(method: 'paypal'): boolean }>;
  createPayPalOneTimePaymentSession(options: {
    onApprove: (data: { orderId: string }) => Promise<void>;
    onCancel: () => void;
    commit: true;
    onError: (error: unknown) => void;
  }): PayPalSession;
}
declare global {
  interface Window {
    paypal?: {
      createInstance(options: {
        clientId: string;
        components: ['paypal-payments'];
        pageType: 'checkout';
      }): Promise<PayPalInstance>;
    };
  }
}
let loading: Promise<void> | undefined;
export async function loadPayPal(clientId: string): Promise<PayPalInstance> {
  if (!window.paypal) {
    loading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading = undefined;
        script.remove();
        reject(Error('PayPal SDK could not load. Please retry.'));
      };
      document.head.append(script);
    });
    await loading;
  }
  if (!window.paypal) throw Error('PayPal SDK is unavailable');
  return window.paypal.createInstance({
    clientId,
    components: ['paypal-payments'],
    pageType: 'checkout',
  });
}

export function sanitizePayPalError(error: unknown) {
  const source =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const identifier = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
      ? value
      : undefined;
  const code = identifier(source.code) ?? 'SDK_ERROR';
  // Provider messages may embed payment URLs, tokens or personal information.
  // Preserve a controlled description and allowlisted identifiers only.
  return {
    code,
    message:
      code === 'NETWORK_ERROR'
        ? 'PayPal network request failed'
        : 'PayPal checkout did not finish',
    debugId: identifier(source.debugId ?? source.debug_id),
    correlationId: identifier(source.correlationId ?? source.correlation_id),
  };
}
export function preservePayPalError(error: unknown) {
  const diagnostic = {
    ...sanitizePayPalError(error),
    timestamp: new Date().toISOString(),
  };
  try {
    sessionStorage.setItem(
      'resolveai.paypal.lastError',
      JSON.stringify(diagnostic),
    );
  } catch {
    /* Storage may be disabled. */
  }
  console.warn('PayPal checkout diagnostic', diagnostic);
  return diagnostic;
}
