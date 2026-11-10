import { RootRedirect } from './root-redirect';
import { ComplaintsApp } from './complaints';
import { Checkout } from './checkout';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import { z } from 'zod';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import './style.css';
ModuleRegistry.registerModules([AllCommunityModule]);
const settings = z
  .object({
    api: z
      .string()
      .refine(
        (v) => v.startsWith('/') || URL.canParse(v),
        'Invalid API base URL',
      ),
  })
  .parse({ api: import.meta.env.VITE_API_BASE_URL ?? '/api/v1' });
const origin = settings.api.startsWith('/') ? '' : new URL(settings.api).origin;
function Status() {
  const [state, setState] = useState('Checking API readiness...');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${origin}/ready`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error('API dependencies are unavailable');
        await r.json();
        setState('API, database and Redis are ready.');
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setState(e instanceof Error ? e.message : 'API is unavailable');
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <Card>
      <h1 className="text-2xl font-semibold">System status</h1>
      <p role="status" className="my-5">
        {state}
      </p>
      <Button
        onClick={() => {
          setState('Checking API readiness...');
          setAttempt((v) => v + 1);
        }}
      >
        Check again
      </Button>
    </Card>
  );
}
function App() {
  return (
    <>
      <div className="bg-amber-100 px-6 py-2 text-sm text-amber-950">
        Demo & Sandbox - Human-approved resolutions - Real refunds disabled
      </div>
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 p-6">
        <Link to="/" className="text-xl font-bold">
          ResolveAI
        </Link>
        <nav aria-label="Main" className="flex flex-wrap gap-5">
          <Link to="/login">Sign in</Link>
          <Link to="/orders">Orders</Link>
          <Link to="/complaints">Complaints</Link>
          <Link to="/checkout">Sandbox checkout</Link>
          <Link to="/status">System status</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Routes>
          {[
            '/login',
            '/orders',
            '/complaints',
            '/complaints/new',
            '/complaints/:caseId',
            '/merchant/:merchantId/cases',
            '/merchant/:merchantId/cases/:caseId',
            '/merchant/:merchantId/policies',
            '/merchant/:merchantId/analytics',
          ].map((path) => (
            <Route key={path} path={path} element={<ComplaintsApp />} />
          ))}
          <Route path="/" element={<RootRedirect />} />
          <Route path="/status" element={<Status />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route
            path="*"
            element={
              <Card>
                <h1>Page not found</h1>
                <Link to="/">Return home</Link>
              </Card>
            }
          />
        </Routes>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
