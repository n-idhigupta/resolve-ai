import { useEffect, useState } from 'react';
import {
  analyticsSchema,
  formatMinorTotal,
  type MerchantAnalytics,
} from '@resolveai/shared';
import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
const date = (d: Date) => d.toISOString().slice(0, 10),
  field = 'mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2';
export function AnalyticsDashboard({ merchantId }: { merchantId: string }) {
  const [data, setData] = useState<MerchantAnalytics | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [from, setFrom] = useState(date(new Date(Date.now() - 30 * 86400000))),
    [to, setTo] = useState(date(new Date(Date.now() + 86400000))),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void fetch(
      `${base}/merchants/${merchantId}/analytics?from=${encodeURIComponent(from + 'T00:00:00.000Z')}&to=${encodeURIComponent(to + 'T00:00:00.000Z')}`,
      { credentials: 'include', signal: controller.signal },
    )
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok)
          throw Error(
            r.status === 404
              ? 'This merchant workspace is unavailable to your account.'
              : r.status === 429
                ? 'Too many requests. Wait a minute and try again.'
                : (b.detail ?? 'Analytics unavailable'),
          );
        return analyticsSchema.parse(b.data);
      })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [merchantId, from, to, attempt]);
  const percent = (v: number | null) =>
      v === null ? 'No data' : (v / 100).toFixed(1) + '%',
    duration = (v: number | null) =>
      v === null
        ? 'No resolved cases'
        : v < 1
          ? (v * 60).toFixed(1) + ' min'
          : v.toFixed(1) + ' h';
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">
            Merchant intelligence
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Resolution analytics</h1>
          <p className="mt-2 max-w-2xl text-slate-600">
            A clear view of complaints, human decisions and recorded outcomes.
            Internal complaints are not PayPal disputes.
          </p>
        </div>
        <Button disabled={busy} onClick={() => setAttempt((x) => x + 1)}>
          Refresh analytics
        </Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <label className="grid text-sm font-medium">
            From (UTC)
            <input
              type="date"
              className={field}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </label>
          <label className="grid text-sm font-medium">
            Until (exclusive UTC)
            <input
              type="date"
              className={field}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </label>
          <p className="text-sm text-slate-500">
            Up to 366 days. Future end times are capped at the server snapshot.
          </p>
        </div>
      </Card>
      {error && (
        <Card>
          <p role="alert" className="text-red-800">
            {error}
          </p>
          <Button onClick={() => setAttempt((x) => x + 1)}>
            Try analytics again
          </Button>
        </Card>
      )}
      {busy && (
        <p role="status" className="rounded-lg bg-slate-100 p-4">
          Loading server-calculated metrics...
        </p>
      )}
      {data && !busy && (
        <>
          <p className="text-xs text-slate-500">
            Consistent tenant snapshot as of{' '}
            {new Date(data.asOf).toLocaleString()}. Mock results are
            demonstrations, not real provider verification.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                label: 'Complaints opened',
                value: String(data.complaints.total),
                hint: `${data.complaints.closedWithoutAgreement} closed without agreement`,
              },
              {
                label: 'Resolution rate',
                value: percent(data.complaints.resolutionRateBps),
                hint: 'Resolved / opened in the selected cohort',
              },
              {
                label: 'Average time to resolve',
                value: duration(data.complaints.averageResolutionHours),
                hint: `${data.complaints.durationSamples} cases resolved in this interval`,
              },
              {
                label: 'Settlements completed',
                value: String(data.settlements.completed),
                hint: `${data.settlements.total} accepted in this cohort`,
              },
            ].map((m) => (
              <Card key={m.label}>
                <p className="text-sm font-medium text-slate-500">{m.label}</p>
                <p
                  className="my-3 text-3xl font-semibold tracking-tight"
                  data-testid={
                    'metric-' + m.label.toLowerCase().replaceAll(' ', '-')
                  }
                >
                  {m.value}
                </p>
                <p className="text-xs text-slate-500">{m.hint}</p>
              </Card>
            ))}
          </div>
          {!data.complaints.total && (
            <Card>
              <h2 className="font-semibold">No complaints in this interval</h2>
              <p className="mt-2 text-slate-600">
                Choose a different date range, or use the synthetic demo
                journey. No success rate is inferred from an empty cohort.
              </p>
            </Card>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <h2 className="text-xl font-semibold">Complaint status</h2>
              <ul className="mt-5 grid gap-4">
                {data.complaints.status.map((s) => (
                  <li key={s.status}>
                    <div className="mb-1 flex justify-between gap-3 text-sm">
                      <span>{s.status.replaceAll('_', ' ').toLowerCase()}</span>
                      <span className="font-semibold">{s.count}</span>
                    </div>
                    <meter
                      className="h-3 w-full accent-teal-700"
                      aria-label={s.status + ' complaints'}
                      min={0}
                      max={Math.max(1, data.complaints.total)}
                      value={s.count}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-sm text-slate-500">
                Median {duration(data.complaints.medianResolutionHours)}; p95{' '}
                {duration(data.complaints.p95ResolutionHours)}. Nonfinancial
                closure is not counted as resolution.
              </p>
            </Card>
            <Card>
              <h2 className="text-xl font-semibold">Complaint volume by day</h2>
              <div className="mt-4 max-h-72 overflow-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Complaints opened each UTC day
                  </caption>
                  <thead>
                    <tr className="border-b">
                      <th className="py-2" scope="col">
                        UTC date
                      </th>
                      <th scope="col" className="text-right">
                        Opened
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.complaints.daily.map((d) => (
                      <tr key={d.day} className="border-b border-slate-100">
                        <td className="py-3">{d.day}</td>
                        <td className="text-right tabular-nums">{d.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-sm text-slate-500">
                Verified capture cohort:{' '}
                {data.complaints.capturedOrdersWithComplaint} of{' '}
                {data.complaints.capturedOrders} purchases have a complaint by
                this snapshot. Synthetic purchases may be included; this is not
                a chargeback-prevention claim.
              </p>
            </Card>
          </div>
          <Card>
            <div className="flex flex-wrap justify-between gap-3">
              <h2 className="text-xl font-semibold">
                Refunds & reserved exposure
              </h2>
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950">
                Mock and provider records separated
              </span>
            </div>
            {!data.refunds.length ? (
              <p className="my-5 text-slate-500">
                No refund operations recorded.
              </p>
            ) : (
              <div className="mt-4 overflow-auto">
                <table className="w-full min-w-[660px] text-left text-sm">
                  <caption className="mb-3 text-left text-xs text-slate-500">
                    Completed totals use the interval; pending/unknown exposure
                    includes all dates. All amounts remain separated by
                    currency.
                  </caption>
                  <thead>
                    <tr className="border-b">
                      {[
                        'Currency',
                        'Mock completed',
                        'Provider recorded',
                        'External recorded',
                        'Pending',
                        'Unknown',
                      ].map((h) => (
                        <th key={h} scope="col" className="p-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.refunds.map((r) => (
                      <tr key={r.currency} className="border-b">
                        <th scope="row" className="p-2">
                          {r.currency}
                        </th>
                        {[
                          r.mockCompletedMinor,
                          r.recordedProviderCompletedMinor,
                          r.externalCompletedMinor,
                          r.pendingMinor,
                          r.unknownMinor,
                        ].map((m, i) => (
                          <td key={i} className="p-2 tabular-nums">
                            {formatMinorTotal(m)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-sm text-slate-500">
              Unknown outcomes retain their reservation and require
              reconciliation. They are never counted as successful refunds.
            </p>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <h2 className="text-xl font-semibold">
                AI assistance & human review
              </h2>
              <dl className="mt-5 grid grid-cols-2 gap-4">
                {[
                  ['Analyses', data.ai.analyses],
                  ['Local mock analyses', data.ai.mockAnalyses],
                  ['Recommendations', data.ai.recommendations],
                  ['Reviewed analyses', data.ai.reviewed],
                  [
                    'Approved / revised',
                    `${data.ai.approved} / ${data.ai.revised}`,
                  ],
                  ['Approval rate', percent(data.ai.approvalRateBps)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-sm text-slate-500">{k}</dt>
                    <dd className="mt-1 text-2xl font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-5 text-sm text-slate-500">
                Latest review per analysis. These metrics measure workflow
                activity, not model accuracy. An AI review never authorizes
                money.
              </p>
            </Card>
            <Card>
              <h2 className="text-xl font-semibold">Merchant decisions</h2>
              <p className="my-4 text-3xl font-semibold">
                {data.settlements.merchantFinancialAuthorizations}
              </p>
              <p className="text-sm text-slate-600">
                Explicit merchant settlement authorizations in the interval,
                separate from internal AI approvals.
              </p>
              <ul className="mt-5 grid gap-2 text-sm">
                {data.settlements.status.map((s) => (
                  <li
                    key={s.status}
                    className="flex justify-between rounded bg-slate-50 p-2"
                  >
                    <span>{s.status.replaceAll('_', ' ').toLowerCase()}</span>
                    <strong>{s.count}</strong>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <details className="rounded-xl border bg-white p-5">
            <summary className="cursor-pointer font-medium">
              Metric definitions & limits
            </summary>
            <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm text-slate-600">
              {data.definitions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
