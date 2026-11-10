import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import {
  loginDestination,
  loginSessionSchema,
  type LoginRole,
  type LoginSession,
} from './login-session';
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
export function Login({
  onLogin,
}: {
  onLogin: (session: LoginSession) => void;
}) {
  const location = useLocation(),
    navigate = useNavigate();
  const [role, setRole] = useState<LoginRole>(
    location.pathname.startsWith('/merchant/') ? 'merchant' : 'customer',
  );
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<LoginSession | null>(null),
    [tenant, setTenant] = useState('');
  function finish(session: LoginSession, merchantId?: string) {
    const target = loginDestination(
      role,
      session.memberships,
      location.pathname,
      merchantId,
    );
    if (!target) return;
    onLogin(session);
    navigate(target, { replace: true });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await fetch(base + '/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok)
        throw Error(
          r.status === 401
            ? 'Email or password is incorrect.'
            : r.status === 429
              ? 'Too many sign-in attempts. Please wait before trying again.'
              : 'Sign in is unavailable. Please try again.',
        );
      const session = loginSessionSchema.parse((await r.json()).data);
      setPassword('');
      if (role === 'merchant' && !session.memberships.length) {
        setError(
          'This account has no merchant workspace. Choose Customer to sign in to your orders.',
        );
        return;
      }
      if (role === 'merchant' && session.memberships.length > 1) {
        setPending(session);
        setTenant('');
        return;
      }
      finish(session);
    } catch (e) {
      setError(
        e instanceof Error && !(e instanceof SyntaxError) && !('issues' in e)
          ? e.message
          : 'Sign in returned an invalid response. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mx-auto max-w-2xl overflow-hidden border-slate-200 p-6 sm:p-10">
      <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-teal-700">
        Your resolution workspace
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
        Sign in to ResolveAI
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        Choose your workspace to continue. Internal complaints are separate from
        PayPal disputes.
      </p>
      <div
        role="group"
        aria-label="Choose your workspace"
        className="my-7 grid gap-3 sm:grid-cols-2"
      >
        {(['customer', 'merchant'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={role === value}
            disabled={busy}
            onClick={() => {
              setRole(value);
              setPassword('');
              setError('');
              setPending(null);
              setTenant('');
            }}
            className={
              'rounded-xl border-2 p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700 disabled:opacity-60 ' +
              (role === value
                ? 'border-teal-700 bg-teal-50 shadow-sm'
                : 'border-slate-200 bg-white hover:border-slate-400')
            }
          >
            <span className="flex items-center justify-between gap-3">
              <span className="font-semibold capitalize text-slate-950">
                {value === 'customer' ? 'Customer' : 'Merchant'}
              </span>
              <span
                aria-hidden="true"
                className={
                  'h-4 w-4 rounded-full border-2 ' +
                  (role === value
                    ? 'border-teal-700 bg-teal-700'
                    : 'border-slate-300')
                }
              />
            </span>
            <span className="mt-2 block text-sm leading-5 text-slate-600">
              {value === 'customer'
                ? 'Track orders, raise a complaint and review offers.'
                : 'Review cases, manage policies and help customers.'}
            </span>
          </button>
        ))}
      </div>
      <h2 className="mb-4 text-lg font-semibold capitalize">
        {role === 'customer' ? 'Customer' : 'Merchant'} login
      </h2>
      {pending ? (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            finish(pending, tenant);
          }}
        >
          <label className="grid gap-2 text-sm font-medium">
            Merchant workspace
            <select
              required
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white p-3"
            >
              <option value="">Choose an authorized workspace</option>
              {pending.memberships.map((m) => (
                <option key={m.merchantId} value={m.merchantId}>
                  {m.role} � {m.merchantId}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={!tenant}>Open workspace</Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
          aria-label={role === 'customer' ? 'Customer login' : 'Merchant login'}
          className="grid gap-4"
        >
          <label className="grid gap-2 text-sm font-medium">
            Email
            <input
              type="email"
              autoComplete="username"
              required
              disabled={busy}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white p-3 text-slate-950 focus:outline-teal-700"
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white p-3 text-slate-950 focus:outline-teal-700"
            />
          </label>
          <Button
            disabled={busy}
            className="mt-1 w-full bg-teal-800 py-3 hover:bg-teal-900"
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      )}
      <p role="alert" className="mt-4 text-sm text-red-700">
        {error}
      </p>
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Workspace access is verified by your account permissions. Selecting
        Merchant does not grant merchant access.
      </p>
    </Card>
  );
}
