import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { moneySchema, paymentStateSchema } from '@resolveai/shared';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import {
  loadPayPal,
  preservePayPalError,
  type PayPalSession,
} from './paypal-sdk';
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
const sessionSchema = z.object({
  user: z.object({ id: z.uuid(), email: z.string() }),
  csrfToken: z.string(),
});
type Session = z.infer<typeof sessionSchema>;
const orderSchema = z.object({
  id: z.uuid(),
  version: z.number(),
  status: z.string(),
  paymentState: z.string(),
  total: moneySchema,
});
type Order = z.infer<typeof orderSchema>;
const operationSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  providerOrderId: z.string().nullable(),
  errorCode: z.string().nullable(),
});
const paymentSchema = z.object({
  orderId: z.uuid(),
  status: paymentStateSchema,
  version: z.number(),
  money: moneySchema,
  capture: z
    .object({
      providerCaptureId: z.string(),
      grossMinor: z.string(),
      currency: z.string(),
      completedAt: z.string().nullable(),
      verifiedAt: z.string().nullable(),
      providerStatus: z.string(),
    })
    .nullable(),
});
type Payment = z.infer<typeof paymentSchema>;
async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(base + path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ detail: z.string().optional() }).safeParse(body);
    throw Error(
      response.status === 401
        ? 'Sign in to continue.'
        : error.success
          ? (error.data.detail ?? 'Request failed')
          : 'Request failed',
    );
  }
  return z.object({ data: schema }).parse(body).data;
}
const money = (minor: string) =>
  '$' +
  (BigInt(minor) / 100n).toString() +
  '.' +
  (BigInt(minor) % 100n).toString().padStart(2, '0') +
  ' USD';
export function Checkout() {
  const [session, setSession] = useState<Session | null>(null),
    [orders, setOrders] = useState<Order[]>([]),
    [selected, setSelected] = useState(''),
    [payment, setPayment] = useState<Payment | null>(null),
    [message, setMessage] = useState('Checking your session...'),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [sdk, setSdk] = useState<PayPalSession | null>(null);
  const keys = useRef(new Map<string, string>()),
    activeOrder = useRef(''),
    expectedProvider = useRef('');
  activeOrder.current = selected;
  const key = (kind: string) => {
    const id = selected + ':' + kind;
    let value = keys.current.get(id);
    if (!value) {
      value = crypto.randomUUID();
      keys.current.set(id, value);
    }
    return value;
  };
  useEffect(() => {
    let alive = true;
    api('/auth/session', sessionSchema)
      .then((value) => {
        if (alive) {
          setSession(value);
          setMessage('Select an unpaid order to continue.');
        }
      })
      .catch(() => {
        if (alive)
          setMessage('Sign in with your development customer account.');
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    api('/orders', z.array(orderSchema))
      .then((value) => {
        if (alive) {
          setOrders(value);
          setSelected(value[0]?.id ?? '');
        }
      })
      .catch((e) => {
        if (alive)
          setMessage(e instanceof Error ? e.message : 'Orders unavailable');
      });
    return () => {
      alive = false;
    };
  }, [session]);
  useEffect(() => {
    if (!session || !selected) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    setPayment(null);
    const refresh = async () => {
      try {
        const value = await api(
          '/orders/' + selected + '/payments',
          paymentSchema,
        );
        if (alive) {
          setPayment(value);
          if (!['CAPTURED', 'FAILED', 'CANCELLED'].includes(value.status))
            timer = setTimeout(() => {
              void refresh();
            }, 2000);
        }
      } catch (e) {
        if (alive)
          setMessage(
            e instanceof Error ? e.message : 'Payment status unavailable',
          );
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [selected, session]);
  useEffect(() => {
    if (!session || !selected) return;
    let alive = true;
    setSdk(null);
    api(
      '/paypal/config',
      z.object({
        enabled: z.boolean(),
        clientId: z.string().nullable(),
        environment: z.literal('sandbox'),
      }),
    )
      .then(async (config) => {
        if (!config.enabled || !config.clientId) {
          if (alive)
            setMessage(
              'Sandbox checkout is not configured. Add server-side PayPal settings to enable it.',
            );
          return;
        }
        const instance = await loadPayPal(config.clientId);
        const eligibility = await instance.findEligibleMethods({
          currencyCode: 'USD',
        });
        if (!eligibility.isEligible('paypal')) {
          if (alive)
            setMessage('PayPal is not available for this Sandbox account.');
          return;
        }
        const current = selected;
        const paymentSession = instance.createPayPalOneTimePaymentSession({
          commit: true,
          onApprove: async (data) => {
            if (activeOrder.current !== current) return;
            if (
              expectedProvider.current &&
              data.orderId !== expectedProvider.current
            )
              throw Error('PayPal returned a different order.');
            setMessage(
              'Approval received. Waiting for verified server capture...',
            );
            const status = await api(
              '/orders/' + current + '/payments',
              paymentSchema,
            );
            if (status.status === 'CAPTURED') {
              setPayment(status);
              setBusy(false);
              return;
            }
            const captureKey =
              keys.current.get(current + ':capture') ?? crypto.randomUUID();
            keys.current.set(current + ':capture', captureKey);
            let result;
            for (let retry = 0; retry < 2; retry++) {
              const fresh = await api(
                '/orders/' + current + '/payments',
                paymentSchema,
              );
              if (fresh.status === 'CAPTURED') {
                setPayment(fresh);
                break;
              }
              try {
                result = await api(
                  '/orders/' + current + '/capture',
                  operationSchema,
                  {
                    method: 'POST',
                    headers: {
                      'x-csrf-token': session.csrfToken,
                      'idempotency-key': captureKey,
                      'if-match': String(fresh.version),
                    },
                    body: JSON.stringify({ providerOrderId: data.orderId }),
                  },
                );
                break;
              } catch (error) {
                if (retry === 1) throw error;
              }
            }
            if (result)
              setMessage(
                'Capture is processing. This page will show the server-verified result.',
              );
            setBusy(false);
          },
          onCancel: () => {
            if (alive) {
              setBusy(false);
              setMessage(
                'PayPal approval window closed. No local success was recorded. You can resume the same checkout.',
              );
            }
          },
          onError: (error) => {
            preservePayPalError(error);
            if (alive) {
              setBusy(false);
              setMessage(
                'PayPal checkout did not finish. Check the payment status before trying again.',
              );
            }
          },
        });
        if (paymentSession.hasReturned()) await paymentSession.resume();
        if (alive) setSdk(paymentSession);
      })
      .catch((e) => {
        if (alive)
          setMessage(
            e instanceof Error ? e.message : 'PayPal could not initialize',
          );
      });
    return () => {
      alive = false;
    };
  }, [selected, session]);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      setSession(
        await api('/auth/login', sessionSchema, {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        }),
      );
      setPassword('');
      setMessage('Select an unpaid order to continue.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }
  function pay() {
    if (!sdk || !session || !selected) return;
    setBusy(true);
    setMessage('Preparing your secure Sandbox checkout...');
    const order = orders.find((x) => x.id === selected)!;
    const checkoutKey = key('create');
    const prepare = async () => {
      const op = await api(
        '/orders/' + selected + '/checkout',
        operationSchema,
        {
          method: 'POST',
          headers: {
            'x-csrf-token': session.csrfToken,
            'idempotency-key': checkoutKey,
            'if-match': String(payment?.version ?? order.version),
          },
          body: '{}',
        },
      );
      let current = op;
      for (let poll = 0; poll < 120; poll++) {
        if (current.providerOrderId && current.state === 'COMPLETED') {
          expectedProvider.current = current.providerOrderId;
          return { orderId: current.providerOrderId };
        }
        if (['FAILED', 'UNKNOWN'].includes(current.state))
          throw Error(
            current.state === 'UNKNOWN'
              ? 'Payment outcome requires reconciliation. Please wait for the server.'
              : 'PayPal order creation failed.',
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
        current = await api('/payment-operations/' + op.id, operationSchema);
      }
      throw Error(
        'Checkout is still preparing. Check the payment status before retrying.',
      );
    };
    void sdk.start({ presentationMode: 'auto' }, prepare()).catch((e) => {
      setBusy(false);
      setMessage(e instanceof Error ? e.message : 'Checkout could not start');
    });
  }
  return (
    <div className="grid gap-6">
      <Card>
        <h1 className="text-2xl font-semibold">PayPal Sandbox checkout</h1>
        <p className="mt-2 text-slate-600">
          Approve a payment in PayPal. ResolveAI confirms success only after
          verifying the capture on the server.
        </p>
        <p role="status" className="my-4">
          {payment?.status === 'CAPTURED'
            ? 'Payment captured and verified.'
            : message}
        </p>
        {!session ? (
          <form
            onSubmit={(event) => {
              void signIn(event);
            }}
            className="grid max-w-md gap-3"
          >
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded border p-2"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded border p-2"
              />
            </label>
            <Button disabled={busy}>Sign in</Button>
          </form>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              Signed in as {session.user.email}
            </p>
            <label className="my-4 block">
              Your order
              <select
                className="ml-3 rounded border p-2"
                disabled={busy}
                value={selected}
                onChange={(e) => {
                  expectedProvider.current = '';
                  setSelected(e.target.value);
                }}
              >
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.id.slice(0, 8)} · {money(order.total.minor)} ·{' '}
                    {order.status}
                  </option>
                ))}
              </select>
            </label>
            {!orders.length ? (
              <p>No orders are available.</p>
            ) : (
              <>
                <p className="mb-4 font-semibold">
                  {payment
                    ? money(payment.money.minor)
                    : money(orders.find((x) => x.id === selected)!.total.minor)}
                </p>
                <Button
                  onClick={pay}
                  disabled={
                    !sdk ||
                    busy ||
                    payment?.status === 'CAPTURED' ||
                    payment?.status === 'FAILED' ||
                    payment?.status === 'RECONCILIATION_REQUIRED' ||
                    orders.find((x) => x.id === selected)?.status === 'PAID'
                  }
                >
                  Pay with PayPal Sandbox
                </Button>
              </>
            )}
          </>
        )}
      </Card>
      {payment && (
        <Card>
          <h2 className="text-xl font-semibold">Payment status</h2>
          <p className="my-3" data-testid="payment-state">
            {payment.status.replaceAll('_', ' ')}
          </p>
          {payment.status === 'RECONCILIATION_REQUIRED' && (
            <p>
              ResolveAI is checking the provider outcome. Do not start another
              payment.
            </p>
          )}
          {payment.capture?.verifiedAt && (
            <dl className="grid gap-2">
              <dt>Verified PayPal capture</dt>
              <dd className="break-all font-mono">
                {payment.capture.providerCaptureId}
              </dd>
              <dt>Captured amount</dt>
              <dd>{money(payment.capture.grossMinor)}</dd>
              <dt>Verified at</dt>
              <dd>{new Date(payment.capture.verifiedAt).toLocaleString()}</dd>
            </dl>
          )}
        </Card>
      )}
    </div>
  );
}
