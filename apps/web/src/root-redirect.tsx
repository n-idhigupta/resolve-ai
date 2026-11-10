import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import {
  loginDestination,
  loginSessionSchema,
  type LoginSession,
} from './login-session';
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
type State =
  | { kind: 'loading' }
  | { kind: 'guest' }
  | { kind: 'ready'; session: LoginSession }
  | { kind: 'error' };
export function RootRedirect() {
  const [state, setState] = useState<State>({ kind: 'loading' }),
    [attempt, setAttempt] = useState(0),
    [tenant, setTenant] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const r = await fetch(base + '/auth/session', {
          credentials: 'include',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (r.status === 401) {
          setState({ kind: 'guest' });
          return;
        }
        if (!r.ok) throw Error('SESSION_UNAVAILABLE');
        const session = loginSessionSchema.parse((await r.json()).data);
        if (!controller.signal.aborted) setState({ kind: 'ready', session });
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, [attempt]);
  if (state.kind === 'loading')
    return <p role="status">Checking your session...</p>;
  if (state.kind === 'guest') return <Navigate to="/login" replace />;
  if (state.kind === 'error')
    return (
      <Card>
        <h1 className="text-xl font-semibold">Unable to check your session</h1>
        <p role="alert" className="my-4">
          Your session could not be verified. Please try again.
        </p>
        <Button onClick={() => setAttempt((v) => v + 1)}>Try again</Button>
      </Card>
    );
  const { session } = state;
  const role = session.memberships.length ? 'merchant' : 'customer';
  const destination = loginDestination(
    role,
    session.memberships,
    '/',
    tenant || undefined,
  );
  if (destination) return <Navigate to={destination} replace />;
  return (
    <Card>
      <h1 className="text-2xl font-semibold">Choose your merchant workspace</h1>
      <p className="my-3 text-slate-600">
        Select one of the workspaces authorized for your account.
      </p>
      <form
        className="grid max-w-xl gap-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="grid gap-2">
          Merchant workspace
          <select
            required
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
            className="rounded-lg border border-slate-300 bg-white p-3"
          >
            <option value="">Choose an authorized workspace</option>
            {session.memberships.map((m) => (
              <option key={m.merchantId} value={m.merchantId}>
                {m.role} � {m.merchantId}
              </option>
            ))}
          </select>
        </label>
      </form>
    </Card>
  );
}
