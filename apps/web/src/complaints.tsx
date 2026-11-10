import { MerchantCasesGrid, type MerchantCaseRow } from './merchant-grid';
import { AnalyticsDashboard } from './analytics';
import { NegotiationPanel } from './negotiation';
import { IntelligencePanel } from './intelligence';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useLocation } from 'react-router';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz, type ColDef } from 'ag-grid-community';
import { z } from 'zod';
import {
  complaintReasonSchema,
  policyDocumentSchema,
  minorToDecimal,
} from '@resolveai/shared';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
type Session = {
  user: { id: string; email: string };
  csrfToken: string;
  memberships: { merchantId: string; role: string }[];
};
type Order = {
  id: string;
  status: string;
  paymentState: string;
  version: number;
  total: { minor: string; currency: string };
};
type Case = {
  id: string;
  merchantId: string;
  orderId: string;
  title: string;
  description: string;
  reason: string;
  requestedOutcome: string;
  status: string;
  version: number;
  merchantActor?: boolean;
  openedBy: string;
  policySnapshot: {
    legacy?: boolean;
    reviewReasons?: string[];
    requiredEvidenceTypes?: string[];
  };
  order?: {
    paymentState: string;
    providerCaptureId: string;
    verifiedAt: string;
  };
  aiReview?: NonNullable<MerchantCaseRow['aiReview']> | null;
  createdAt: string;
};
type Comment = {
  id: string;
  body: string;
  visibility: string;
  createdAt: string;
};
type Timeline = {
  actorId: string | null;
  id: string;
  action: string;
  previousStatus: string | null;
  newStatus: string | null;
  createdAt: string;
  metadata: { legacyPolicy?: boolean; mode?: string };
};
type Evidence = {
  id: string;
  filename: string;
  scanStatus: string;
  uploadState: string;
  failureCode: string | null;
};
type Document = z.infer<typeof policyDocumentSchema>;
type Draft = {
  id: string;
  version: number;
  document: Document;
  publishedVersionId: string | null;
};
type Version = {
  id: string;
  sequence: number;
  publishedAt: string;
  clauses?: { clauseKey: string; text: string; rulesJson: unknown }[];
};
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
async function request<T>(
  path: string,
  session?: Session,
  options?: {
    method?: string;
    body?: unknown;
    version?: number;
    binary?: ArrayBuffer;
  },
) {
  const r = await fetch(base + path, {
    credentials: 'include',
    method: options?.method ?? 'GET',
    headers: {
      ...(options?.binary
        ? { 'Content-Type': 'application/octet-stream' }
        : { 'Content-Type': 'application/json' }),
      ...(options?.method && options.method !== 'GET'
        ? {
            Origin: window.location.origin,
            'x-csrf-token': session?.csrfToken ?? '',
            'idempotency-key': crypto.randomUUID(),
          }
        : {}),
      ...(options?.version !== undefined
        ? { 'if-match': String(options.version) }
        : {}),
    },
    ...(options?.binary
      ? { body: options.binary }
      : options?.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });
  const result = (await r.json()) as { data: T; detail?: string };
  if (!r.ok)
    throw Error(
      r.status === 401
        ? 'Sign in to continue.'
        : r.status === 429
          ? 'Too many requests. Please wait a minute.'
          : (result.detail ?? 'Request failed'),
    );
  return result.data;
}
const label = (s: string) => s.replaceAll('_', ' ').toLowerCase();
const timelineLabel = (action: string, mode?: string) =>
  (
    ({
      SUBMITTED: 'Complaint submitted',
      PROPOSAL_DRAFTED: 'Private merchant draft created',
      PROPOSAL_OFFERED: 'Merchant published exact terms',
      COUNTEROFFER_CREATED: 'Customer counteroffer submitted',
      SETTLEMENT_ACCEPTED: 'Customer accepted the exact offer',
      REFUND_AUTHORIZED_AND_RESERVED: 'Merchant authorized and reserved funds',
      REFUND_COMPLETED:
        mode === 'mock'
          ? 'Mock refund verified - no PayPal funds moved'
          : 'Recorded refund verified',
      REPLACEMENT_RECEIVED: 'Customer acknowledged replacement receipt',
      CLOSE_WITHOUT_AGREEMENT: 'Closed without a financial agreement',
    }) as Record<string, string>
  )[action] ?? label(action);
const categories = complaintReasonSchema.options;
const inputClass =
  'w-full rounded-md border border-slate-300 bg-white p-2 text-slate-950';
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Card>
      <h1 className="text-2xl font-semibold">Sign in to ResolveAI</h1>
      <p className="my-3 text-slate-600">
        Use your customer or merchant account. Internal complaints are separate
        from PayPal disputes.
      </p>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void request<Session>('/auth/login', undefined, {
            method: 'POST',
            body: { email, password },
          })
            .then(onLogin)
            .catch((e) => setError(String(e.message)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Email
          <input
            className={inputClass}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            className={inputClass}
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <Button disabled={busy}>Sign in</Button>
        <p role="alert">{error}</p>
      </form>
    </Card>
  );
}
export function ComplaintsApp() {
  const [session, setSession] = useState<Session | null | undefined>(),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void request<Session>('/auth/session')
      .then(setSession)
      .catch(() => setSession(null));
  }, []);
  if (session === undefined)
    return <p role="status">Loading your workspace…</p>;
  if (!session) return <Login onLogin={setSession} />;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-4 rounded-lg bg-slate-100 p-4">
        <span className="break-all text-sm">{session.user.email}</span>
        <Link to="/orders">My Orders</Link>
        <Link to="/complaints">My Complaints</Link>
        {session.memberships.map((m) => (
          <span key={m.merchantId} className="flex flex-wrap gap-3">
            <Link to={`/merchant/${m.merchantId}/cases`}>Merchant Cases</Link>
            <Link to={`/merchant/${m.merchantId}/analytics`}>Analytics</Link>
            {m.role === 'OWNER' && (
              <Link to={`/merchant/${m.merchantId}/policies`}>Policies</Link>
            )}
          </span>
        ))}
        <button
          onClick={() => {
            void request('/auth/logout', session, {
              method: 'POST',
              body: {},
            }).then(() => setSession(null));
          }}
        >
          Sign out
        </button>
      </div>
      <Workspace
        key={refresh}
        session={session}
        reload={() => setRefresh((v) => v + 1)}
      />
    </>
  );
}
function Workspace({
  session,
  reload,
}: {
  session: Session;
  reload: () => void;
}) {
  const location = useLocation(),
    params = useParams();
  if (location.pathname.endsWith('/analytics'))
    return <AnalyticsDashboard merchantId={params.merchantId!} />;
  if (location.pathname === '/orders') return <Orders session={session} />;
  if (location.pathname === '/complaints/new')
    return <NewComplaint session={session} />;
  if (params.caseId)
    return (
      <CaseDetail
        key={params.caseId}
        session={session}
        caseId={params.caseId}
        reload={reload}
      />
    );
  if (location.pathname.endsWith('/policies'))
    return <Policies session={session} merchantId={params.merchantId!} />;
  return <CaseList session={session} merchantId={params.merchantId} />;
}
function Orders({ session }: { session: Session }) {
  const [rows, setRows] = useState<Order[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void request<Order[]>('/orders', session)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [session]);
  return (
    <Card>
      <h1 className="text-2xl font-semibold">My Orders</h1>
      <p className="my-3">Verified payments and internal complaint support.</p>
      <p role="alert">{error}</p>
      {!rows ? (
        <p role="status">Loading orders…</p>
      ) : !rows.length ? (
        <p>No orders yet.</p>
      ) : (
        rows.map((o) => (
          <article key={o.id} className="my-4 rounded-lg border p-4">
            <p className="break-all font-medium">{o.id}</p>
            <p>
              USD {minorToDecimal(BigInt(o.total.minor))} ·{' '}
              {label(o.paymentState)}
            </p>
            {o.paymentState === 'CAPTURED' ? (
              <Link
                className="mt-3 inline-block text-teal-800 underline"
                to={'/complaints/new?orderId=' + o.id}
              >
                Open an internal complaint
              </Link>
            ) : (
              <Link to="/checkout">View Sandbox checkout</Link>
            )}
          </article>
        ))
      )}
    </Card>
  );
}
function NewComplaint({ session }: { session: Session }) {
  const navigate = useNavigate(),
    [orders, setOrders] = useState<Order[]>([]),
    [orderId, setOrderId] = useState(
      new URLSearchParams(location.search).get('orderId') ?? '',
    ),
    [reason, setReason] = useState('OTHER'),
    [eligibility, setEligibility] = useState<{
      eligible: boolean;
      legacy: boolean;
      blockingReasons: string[];
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void request<Order[]>('/orders', session)
      .then(setOrders)
      .catch((e) => setError(e.message));
  }, [session]);
  useEffect(() => {
    setEligibility(null);
    if (orderId)
      void request<typeof eligibility>(
        `/orders/${orderId}/complaint-eligibility?reason=${reason}`,
        session,
      )
        .then(setEligibility)
        .catch((e) => setError(e.message));
  }, [orderId, reason, session]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const c = await request<Case>('/cases', session, {
        method: 'POST',
        body: {
          orderId,
          reason,
          title: form.get('title'),
          description: form.get('description'),
          requestedOutcome: form.get('outcome'),
          desiredResolution: form.get('desired'),
        },
      });
      void navigate('/complaints/' + c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h1 className="text-2xl font-semibold">New internal complaint</h1>
      <p className="my-3 text-slate-600">
        This opens a ResolveAI support case, not a formal PayPal dispute.
        Requested remedies are not settlement offers.
      </p>
      <form className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <label>
          Order
          <select
            className={inputClass}
            aria-label="Order"
            value={orderId}
            required
            onChange={(e) => setOrderId(e.target.value)}
          >
            <option value="">Select a captured order</option>
            {orders
              .filter((o) => o.paymentState === 'CAPTURED')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · USD {minorToDecimal(BigInt(o.total.minor))}
                </option>
              ))}
          </select>
        </label>
        <label>
          Category
          <select
            className={inputClass}
            aria-label="Category"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        {eligibility?.legacy && <Legacy />}
        {eligibility && !eligibility.eligible && (
          <p role="alert">
            Cannot submit: {eligibility.blockingReasons.map(label).join(', ')}.
            Three cases per order maximum, with 24 hours between closed and new
            cases.
          </p>
        )}
        <label>
          Title
          <input
            className={inputClass}
            name="title"
            required
            minLength={5}
            maxLength={160}
          />
        </label>
        <label>
          Description
          <textarea
            className={inputClass}
            rows={5}
            name="description"
            required
            minLength={20}
            maxLength={5000}
          />
        </label>
        <label>
          Desired outcome
          <select
            className={inputClass}
            name="outcome"
            aria-label="Desired outcome"
          >
            {['HELP', 'FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT'].map(
              (s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          What would help?
          <textarea className={inputClass} name="desired" maxLength={2000} />
        </label>
        <p>
          Attach supporting evidence after submission. Evidence becomes
          downloadable only after validation and a real malware scan.
        </p>
        <Button disabled={busy || !eligibility?.eligible}>
          Submit complaint
        </Button>
        <p role="alert">{error}</p>
      </form>
    </Card>
  );
}
function Legacy() {
  return (
    <p className="my-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      Legacy purchase policy: no published clauses were recorded for this order.
      A human will review your complaint. No refund entitlement or offer is
      implied.
    </p>
  );
}
function CaseList({
  session,
  merchantId,
}: {
  session: Session;
  merchantId: string | undefined;
}) {
  const [rows, setRows] = useState<Case[] | null>(null),
    [status, setStatus] = useState(''),
    [reason, setReason] = useState(''),
    [search, setSearch] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [cursor, setCursor] = useState(''),
    [sort, setSort] = useState('newest'),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    setLoading(true);
    setError('');
    setRows(null);
    const q = new URLSearchParams({ limit: '25', sort });
    if (status) q.set('status', status);
    if (reason) q.set('reason', reason);
    if (search) q.set('search', search);
    if (from) q.set('from', new Date(from).toISOString());
    if (to) q.set('to', new Date(to).toISOString());
    if (cursor) q.set('cursor', cursor);
    let alive = true;
    void fetch(
      base +
        (merchantId ? `/merchants/${merchantId}/cases` : '/cases') +
        '?' +
        q,
      { credentials: 'include' },
    )
      .then(async (r) => {
        const b = (await r.json()) as {
          data: Case[];
          page: { nextCursor: string | null };
          detail: string;
        };
        if (!r.ok)
          throw Error(
            b.detail ||
              (r.status === 429
                ? 'Too many requests. Wait a minute and retry.'
                : 'The case inbox could not be loaded.'),
          );
        if (alive) {
          setRows(b.data);
          setNext(b.page.nextCursor);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message ?? 'Cases unavailable');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [
    session,
    merchantId,
    status,
    reason,
    search,
    from,
    to,
    cursor,
    sort,
    retry,
  ]);
  const cols: ColDef<Case>[] = [
    { field: 'title', flex: 2 },
    { field: 'status', flex: 1 },
    { field: 'reason', flex: 1 },
    { field: 'orderId', flex: 2 },
    { field: 'createdAt', flex: 1 },
  ];
  return (
    <Card>
      <div className="flex justify-between">
        <h1 className="text-2xl font-semibold">
          {merchantId ? 'Merchant case inbox' : 'My Complaints'}
        </h1>
        {!merchantId && <Link to="/complaints/new">New complaint</Link>}
      </div>
      <p className="my-3">
        Internal ResolveAI complaints · no financial settlement is executed
        here.
      </p>
      <div className="my-4 grid gap-3 md:grid-cols-3">
        <label>
          Status
          <select
            className={inputClass}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursor('');
            }}
          >
            <option value="">All</option>
            {[
              'OPEN',
              'INVESTIGATING',
              'AWAITING_CUSTOMER',
              'RESOLUTION_PENDING',
              'RESOLVED',
              'ESCALATED',
              'CLOSED_WITHOUT_AGREEMENT',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            className={inputClass}
            aria-label="Category"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setCursor('');
            }}
          >
            <option value="">All</option>
            {categories.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Search title or order
          <input
            className={inputClass}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursor('');
            }}
          />
        </label>
        <label>
          From
          <input
            className={inputClass}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setCursor('');
            }}
          />
        </label>
        <label>
          To (exclusive)
          <input
            className={inputClass}
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setCursor('');
            }}
          />
        </label>
      </div>
      <label>
        Sort by date
        <select
          aria-label="Sort by date"
          className={inputClass}
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setCursor('');
          }}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
      {error && (
        <div role="alert" className="my-4 rounded-lg bg-red-50 p-4">
          <p>{error}</p>
          <Button onClick={() => setRetry((n) => n + 1)}>
            Retry case inbox
          </Button>
        </div>
      )}
      {merchantId ? (
        <>
          {!error && (
            <MerchantCasesGrid
              rows={rows ?? []}
              loading={loading}
              merchantId={merchantId}
            />
          )}
          {!loading && !error && (
            <div className="mt-4 flex gap-3">
              <Button disabled={!cursor} onClick={() => setCursor('')}>
                First server page
              </Button>
              <Button disabled={!next} onClick={() => setCursor(next ?? '')}>
                Next server page
              </Button>
            </div>
          )}
        </>
      ) : rows === null ? (
        <p role="status">Loading cases…</p>
      ) : !rows.length ? (
        <p>No matching complaints.</p>
      ) : (
        <>
          <div className="hidden h-96 md:block">
            <AgGridReact
              theme={themeQuartz}
              rowData={rows}
              columnDefs={cols}
              onRowClicked={(e) => {
                if (e.data)
                  void navigate(
                    (merchantId
                      ? `/merchant/${merchantId}/cases/`
                      : '/complaints/') + e.data.id,
                  );
              }}
            />
          </div>
          <ul className="mt-4 grid gap-2">
            {rows.map((c) => (
              <li key={c.id}>
                <Link
                  className="text-teal-800 underline"
                  to={
                    (merchantId
                      ? `/merchant/${merchantId}/cases/`
                      : '/complaints/') + c.id
                  }
                >
                  {c.title} · {label(c.status)}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-3">
            <Button onClick={() => setCursor('')}>First page</Button>
            <Button disabled={!next} onClick={() => setCursor(next ?? '')}>
              Next page
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
function CaseDetail({
  session,
  caseId,
  reload,
}: {
  session: Session;
  caseId: string;
  reload: () => void;
}) {
  const [c, setCase] = useState<Case | null>(null),
    [comments, setComments] = useState<Comment[]>([]),
    [timeline, setTimeline] = useState<Timeline[]>([]),
    [files, setFiles] = useState<Evidence[]>([]),
    [message, setMessage] = useState(''),
    [privateNote, setPrivateNote] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(''),
    [moreComments, setMoreComments] = useState(true),
    [moreTimeline, setMoreTimeline] = useState(true);
  async function loadHistory(kind: 'comments' | 'timeline') {
    const rows = kind === 'comments' ? comments : timeline;
    const last = rows.at(-1)?.id;
    try {
      if (kind === 'comments') {
        const next = await request<Comment[]>(
          `/cases/${caseId}/comments?limit=25${last ? '&cursor=' + last : ''}`,
          session,
        );
        setComments((old) => [
          ...new Map([...old, ...next].map((x) => [x.id, x])).values(),
        ]);
        setMoreComments(next.length === 25);
      } else {
        const next = await request<Timeline[]>(
          `/cases/${caseId}/timeline?limit=25${last ? '&cursor=' + last : ''}`,
          session,
        );
        setTimeline((old) => [
          ...new Map([...old, ...next].map((x) => [x.id, x])).values(),
        ]);
        setMoreTimeline(next.length === 25);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function refresh() {
    const detail = await request<
      Case & { comments: Comment[]; timeline: Timeline[]; evidence: Evidence[] }
    >('/cases/' + caseId, session);
    setCase(detail);
    setComments((old) =>
      [
        ...new Map([...old, ...detail.comments].map((x) => [x.id, x])).values(),
      ].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
    setTimeline((old) =>
      [
        ...new Map([...old, ...detail.timeline].map((x) => [x.id, x])).values(),
      ].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
    setFiles(detail.evidence);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [caseId, session]);
  const active =
    c && ['OPEN', 'INVESTIGATING', 'AWAITING_CUSTOMER'].includes(c.status);
  async function mutate(kind: string) {
    if (!c) return;
    setBusy(true);
    try {
      await request(
        `/cases/${caseId}` +
          (kind === 'comment' ? '/comments' : '/actions').replace(
            '/actions',
            c.merchantActor ? `/actions` : '/actions',
          ),
        session,
        {
          method: 'POST',
          version: c.version,
          body:
            kind === 'comment'
              ? {
                  body: message,
                  visibility: privateNote ? 'INTERNAL' : 'CUSTOMER',
                }
              : { action, message },
        },
      );
      setMessage('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!c) return;
    setBusy(true);
    setError('Uploading to private quarantine…');
    try {
      const bytes = await file.arrayBuffer();
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const r = await request<{ id: string }>(
        `/cases/${caseId}/evidence/uploads`,
        session,
        {
          method: 'POST',
          version: c.version,
          body: {
            filename: file.name,
            declaredType: file.type || 'text/plain',
            sizeBytes: file.size,
            sha256: hash,
          },
        },
      );
      await request(`/cases/${caseId}/evidence/${r.id}/content`, session, {
        method: 'PUT',
        binary: bytes,
      });
      const fresh = await request<Case>('/cases/' + caseId, session);
      await request(`/cases/${caseId}/evidence/${r.id}/complete`, session, {
        method: 'POST',
        version: fresh.version,
        body: {},
      });
      setError('Upload received. Validation and malware scanning are pending.');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!c)
    return (
      <Card>
        <p role="status">Loading complaint…</p>
        <p role="alert">{error}</p>
        <Button onClick={reload}>Retry</Button>
      </Card>
    );
  const actions = c.merchantActor
    ? [
        ...(c.status === 'OPEN' ? ['BEGIN_REVIEW'] : []),
        ...(['OPEN', 'INVESTIGATING'].includes(c.status)
          ? ['REQUEST_INFORMATION']
          : []),
        'CLOSE_WITHOUT_AGREEMENT',
      ]
    : [...(c.status === 'AWAITING_CUSTOMER' ? ['RESPOND'] : []), 'WITHDRAW'];
  return (
    <div className="grid gap-5">
      <Card>
        <p className="text-sm text-teal-800">
          Internal ResolveAI complaint · not a PayPal dispute
        </p>
        <h1 className="my-2 text-2xl font-semibold">{c.title}</h1>
        <p className="font-medium">{label(c.status)}</p>
        {c.status === 'CLOSED_WITHOUT_AGREEMENT' && (
          <p className="my-3 rounded bg-slate-100 p-3">
            Closed without agreement. This is a nonfinancial closure: no refund,
            payment or settlement was issued.
          </p>
        )}
        <p className="my-3 whitespace-pre-wrap">{c.description}</p>
        <p>Requested outcome: {label(c.requestedOutcome)} (nonbinding)</p>
        <p className="break-all text-sm">
          Order {c.orderId} · {label(c.order?.paymentState ?? '')} · capture{' '}
          {c.order?.providerCaptureId ?? 'unavailable'}
        </p>
        {c.policySnapshot.legacy && <Legacy />}
        {!!c.policySnapshot.requiredEvidenceTypes?.length && (
          <p>
            Evidence requirements:{' '}
            {c.policySnapshot.requiredEvidenceTypes.join(', ')}. Missing
            evidence requires manual review.
          </p>
        )}
      </Card>
      <NegotiationPanel
        session={session}
        caseId={caseId}
        merchantId={c.merchantId}
        merchant={!!c.merchantActor}
        active={!!active}
        synthetic={
          c.order?.providerCaptureId?.startsWith('SYNTHETIC_') ?? false
        }
        onChanged={refresh}
      />
      <IntelligencePanel
        session={session}
        caseId={caseId}
        merchantId={c.merchantId}
        caseVersion={c.version}
        merchant={!!c.merchantActor}
        files={files}
        active={!!active}
      />
      <Card>
        <h2 className="text-xl font-semibold">Evidence</h2>
        <p className="my-2 text-sm">
          JPEG, PNG, PDF or UTF-8 text. 10 MiB/file, ten files per case.
          Downloads require successful validation and a real malware scan.
        </p>
        {active && (
          <label className="block">
            Attach evidence
            <input
              className={inputClass}
              type="file"
              accept=".jpg,.jpeg,.png,.pdf,.txt"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
        )}
        <ul>
          {files.map((f) => (
            <li key={f.id} className="my-3 flex flex-wrap gap-3">
              <span>
                {f.filename} · {label(f.uploadState)} · {label(f.scanStatus)}
              </span>
              {f.scanStatus === 'CLEAN' && f.uploadState === 'AVAILABLE' && (
                <a
                  className="text-teal-800 underline"
                  href={`${base}/cases/${caseId}/evidence/${f.id}/download`}
                >
                  Download {f.filename}
                </a>
              )}
              {f.failureCode && <span>{label(f.failureCode)}</span>}
            </li>
          ))}
        </ul>
        {!files.length && <p>No evidence attached.</p>}
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Discussion</h2>
        {moreComments && comments.length >= 25 && (
          <Button onClick={() => void loadHistory('comments')}>
            Load more comments
          </Button>
        )}
        {comments.map((n) => (
          <article className="my-3 rounded border p-3" key={n.id}>
            <strong>
              {n.visibility === 'INTERNAL'
                ? 'Private merchant note'
                : 'Customer-visible response'}
            </strong>
            <p className="whitespace-pre-wrap">{n.body}</p>
            <time className="text-xs">
              {new Date(n.createdAt).toLocaleString()}
            </time>
          </article>
        ))}
        {active && (
          <>
            <label>
              Message
              <textarea
                className={inputClass}
                maxLength={2000}
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            {c.merchantActor && (
              <label className="my-3 block">
                <input
                  type="checkbox"
                  checked={privateNote}
                  onChange={(e) => setPrivateNote(e.target.checked)}
                />{' '}
                Private merchant note (hidden from customer)
              </label>
            )}
            <Button
              disabled={busy || !message.trim()}
              onClick={() => void mutate('comment')}
            >
              Add comment
            </Button>
            <div className="mt-5 flex flex-wrap gap-3">
              <label>
                Case action
                <select
                  className={inputClass}
                  aria-label="Case action"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="">Select an action</option>
                  {actions.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                disabled={
                  busy ||
                  !action ||
                  (action !== 'BEGIN_REVIEW' && !message.trim())
                }
                onClick={() => {
                  if (c.merchantActor) {
                    setBusy(true);
                    void request(
                      `/merchants/${c.merchantId}/cases/${caseId}/actions`,
                      session,
                      {
                        method: 'POST',
                        version: c.version,
                        body: { action, message },
                      },
                    )
                      .then(() => {
                        setMessage('');
                        return refresh();
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  } else void mutate('action');
                }}
              >
                Apply action
              </Button>
            </div>
          </>
        )}
        <p role="status" className="my-3">
          {error}
        </p>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Case timeline</h2>
        {moreTimeline && timeline.length >= 25 && (
          <Button onClick={() => void loadHistory('timeline')}>
            Load more timeline
          </Button>
        )}
        <ol>
          {timeline.map((t) => (
            <li key={t.id} className="my-3 border-l-2 border-teal-500 pl-3">
              <p>
                {timelineLabel(t.action, t.metadata.mode)}{' '}
                {t.newStatus ? '→ ' + label(t.newStatus) : ''}
              </p>
              <p className="text-xs text-slate-600">
                {!t.actorId
                  ? 'Evidence worker'
                  : t.actorId === session.user.id
                    ? 'You'
                    : t.actorId === c.openedBy
                      ? 'Customer'
                      : 'Merchant'}
              </p>
              {t.metadata.legacyPolicy && (
                <p>Legacy purchase policy: human review required.</p>
              )}
              <time className="text-xs">
                {new Date(t.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
const defaultRules: Document['clauses'][number]['rules'] = {
  schemaVersion: 1,
  applicableReasons: [...categories],
  allowedRemedies: ['HELP', 'FULL_REFUND', 'PARTIAL_REFUND', 'REPLACEMENT'],
  complaintWindowDays: 30,
  requiredEvidenceTypes: [],
  maxPartialRefundBps: 5000,
  maxRefundMinor: null,
  manualReviewThresholdMinor: null,
  mandatoryHumanReview: true,
  replacementAllowed: true,
};
function Policies({
  session,
  merchantId,
}: {
  session: Session;
  merchantId: string;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [versions, setVersions] = useState<Version[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [doc, setDoc] = useState<Document>({
      name: 'Standard support policy',
      clauses: [
        {
          clauseKey: 'standard',
          text: 'Complaints are reviewed by a merchant support agent.',
          rules: { ...defaultRules },
        },
      ],
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const basePath = `/merchants/${merchantId}/policies`;
  async function refresh() {
    setDrafts(await request<Draft[]>(basePath + '/drafts', session));
    setVersions(await request<Version[]>(basePath + '/versions', session));
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [session, merchantId]);
  const owner = session.memberships.some(
    (m) => m.merchantId === merchantId && m.role === 'OWNER',
  );
  if (!owner)
    return <Card>Only merchant owners may manage policy drafts.</Card>;
  async function save(publish = false) {
    setBusy(true);
    try {
      const draft = await request<Draft>(
        basePath + '/drafts' + (selected ? '/' + selected.id : ''),
        session,
        {
          method: selected ? 'PUT' : 'POST',
          body: policyDocumentSchema.parse(doc),
          ...(selected ? { version: selected.version } : {}),
        },
      );
      if (publish) {
        await request(basePath + `/drafts/${draft.id}/validate`, session, {
          method: 'POST',
          body: {},
        });
        await request(basePath + `/drafts/${draft.id}/publish`, session, {
          method: 'POST',
          version: draft.version,
          body: {},
        });
        setSelected(null);
        setError(
          'Published immutable policy. Existing order and case snapshots are unchanged.',
        );
      } else {
        setSelected(draft);
        setError('Draft saved.');
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function patchClause(
    index: number,
    patch: Partial<Document['clauses'][number]>,
  ) {
    setDoc((d) => ({
      ...d,
      clauses: d.clauses.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }
  return (
    <div className="grid gap-5">
      <Card>
        <h1 className="text-2xl font-semibold">Merchant policies</h1>
        <p className="my-3">
          Published policies are immutable purchase snapshots. Policy limits are
          review guidance and never authorize a refund or create a financial
          offer.
        </p>
        <label>
          Policy name
          <input
            className={inputClass}
            value={doc.name}
            onChange={(e) => setDoc({ ...doc, name: e.target.value })}
          />
        </label>
        {doc.clauses.map((clause, i) => (
          <fieldset key={i} className="my-4 grid gap-3 rounded border p-4">
            <legend>Clause {i + 1}</legend>
            <label>
              Clause key
              <input
                className={inputClass}
                value={clause.clauseKey}
                onChange={(e) => patchClause(i, { clauseKey: e.target.value })}
              />
            </label>
            <label>
              Policy wording
              <textarea
                className={inputClass}
                value={clause.text}
                onChange={(e) => patchClause(i, { text: e.target.value })}
              />
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              {categories.map((cat) => (
                <label key={cat}>
                  <input
                    type="checkbox"
                    checked={clause.rules.applicableReasons.includes(cat)}
                    onChange={(e) =>
                      patchClause(i, {
                        rules: {
                          ...clause.rules,
                          applicableReasons: e.target.checked
                            ? [...clause.rules.applicableReasons, cat]
                            : clause.rules.applicableReasons.filter(
                                (c) => c !== cat,
                              ),
                        },
                      })
                    }
                  />{' '}
                  {label(cat)}
                </label>
              ))}
            </div>
            <label>
              Complaint window (days; blank means no policy limit)
              <input
                className={inputClass}
                type="number"
                min={1}
                max={365}
                value={clause.rules.complaintWindowDays ?? ''}
                onChange={(e) =>
                  patchClause(i, {
                    rules: {
                      ...clause.rules,
                      complaintWindowDays: e.target.value
                        ? Number(e.target.value)
                        : null,
                    },
                  })
                }
              />
            </label>
            <label>
              Maximum potential partial refund (%)
              <input
                className={inputClass}
                type="number"
                min={0}
                max={100}
                value={
                  clause.rules.maxPartialRefundBps === null
                    ? ''
                    : clause.rules.maxPartialRefundBps / 100
                }
                onChange={(e) =>
                  patchClause(i, {
                    rules: {
                      ...clause.rules,
                      maxPartialRefundBps: e.target.value
                        ? Math.round(Number(e.target.value) * 100)
                        : null,
                    },
                  })
                }
              />
            </label>
            {(['maxRefundMinor', 'manualReviewThresholdMinor'] as const).map(
              (field) => (
                <label key={field}>
                  {field === 'maxRefundMinor'
                    ? 'Potential refund cap'
                    : 'Manual review threshold'}{' '}
                  (USD cents, blank means unset)
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={clause.rules[field] ?? ''}
                    onChange={(e) =>
                      patchClause(i, {
                        rules: {
                          ...clause.rules,
                          [field]: e.target.value || null,
                        },
                      })
                    }
                  />
                </label>
              ),
            )}
            <label>
              <input
                type="checkbox"
                checked={clause.rules.mandatoryHumanReview}
                onChange={(e) =>
                  patchClause(i, {
                    rules: {
                      ...clause.rules,
                      mandatoryHumanReview: e.target.checked,
                    },
                  })
                }
              />{' '}
              Always require human review for these categories
            </label>
            <div>
              Required evidence{' '}
              {(['IMAGE', 'PDF', 'TEXT'] as const).map((type) => (
                <label className="ml-3" key={type}>
                  <input
                    type="checkbox"
                    checked={clause.rules.requiredEvidenceTypes.includes(type)}
                    onChange={(e) =>
                      patchClause(i, {
                        rules: {
                          ...clause.rules,
                          requiredEvidenceTypes: e.target.checked
                            ? [...clause.rules.requiredEvidenceTypes, type]
                            : clause.rules.requiredEvidenceTypes.filter(
                                (t) => t !== type,
                              ),
                        },
                      })
                    }
                  />{' '}
                  {type}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() =>
              setDoc({
                ...doc,
                clauses: [
                  ...doc.clauses,
                  {
                    clauseKey: 'clause-' + (doc.clauses.length + 1),
                    text: 'Additional manual review policy clause.',
                    rules: { ...defaultRules },
                  },
                ],
              })
            }
          >
            Add clause
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Save draft
          </Button>
          <Button disabled={busy} onClick={() => void save(true)}>
            Validate and publish
          </Button>
          <Button
            onClick={() => {
              setSelected(null);
              setError('Editing a new draft.');
            }}
          >
            New draft
          </Button>
        </div>
        <p role="status" className="my-3">
          {error}
        </p>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Drafts</h2>
        {drafts
          .filter((d) => !d.publishedVersionId)
          .map((d) => (
            <button
              className="my-2 block text-teal-800 underline"
              key={d.id}
              onClick={() => {
                setSelected(d);
                setDoc(d.document);
              }}
            >
              {d.document.name} · revision {d.version}
            </button>
          ))}
        <h2 className="mt-5 text-xl font-semibold">Published history</h2>
        {versions.map((v) => (
          <details
            className="my-3 rounded border p-3"
            key={v.id}
            onToggle={(e) => {
              if (e.currentTarget.open && !v.clauses)
                void request<Version>(
                  basePath + '/versions/' + v.id,
                  session,
                ).then((full) =>
                  setVersions((rows) =>
                    rows.map((row) => (row.id === v.id ? full : row)),
                  ),
                );
            }}
          >
            <summary>
              Version {v.sequence} ·{' '}
              {new Date(v.publishedAt).toLocaleDateString()}
            </summary>
            {v.clauses?.map((c) => (
              <div key={c.clauseKey}>
                <h3>{c.clauseKey}</h3>
                <p>{c.text}</p>
                <pre className="overflow-x-auto text-xs">
                  {JSON.stringify(c.rulesJson, null, 2)}
                </pre>
              </div>
            ))}
          </details>
        ))}
      </Card>
    </div>
  );
}
