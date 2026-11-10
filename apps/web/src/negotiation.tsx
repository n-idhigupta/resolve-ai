import { useEffect, useRef, useState } from 'react';
import { decimalToMinor, minorToDecimal } from '@resolveai/shared';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
type Session = {
  csrfToken: string;
  memberships: { merchantId: string; role: string }[];
};
type Offer = {
  id: string;
  sequence: number;
  rowVersion: number;
  kind: string;
  amountMinor: string | null;
  currency: string | null;
  contentHash: string;
  status: string;
  effectiveStatus: string;
  stale: boolean;
  authorRole: string;
  acceptanceAvailable: boolean;
  expiresAt: string;
  terms: {
    message: string;
    questions?: string[];
    itemDescription?: string;
    shipBy?: string;
  };
};
type Settlement = {
  shipmentReference: string | null;
  id: string;
  proposalId: string;
  state: string;
  refundState: string | null;
  amountMinor: string | null;
  currency: string | null;
  mode: string | null;
  providerRefundId: string | null;
  lastErrorCode: string | null;
};
const input =
  'mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-slate-950';
const pretty = (s: string) => s.replaceAll('_', ' ').toLowerCase();
const money = (v: string | null) =>
  v === null ? 'No financial payment' : `USD ${minorToDecimal(BigInt(v))}`;
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
export function NegotiationPanel({
  session,
  caseId,
  merchantId,
  merchant,
  active,
  synthetic,
  onChanged,
}: {
  session: Session;
  caseId: string;
  merchantId: string;
  merchant: boolean;
  active: boolean;
  synthetic: boolean;
  onChanged: () => Promise<void>;
}) {
  const [offers, setOffers] = useState<Offer[]>([]),
    [settlements, setSettlements] = useState<Settlement[]>([]),
    [version, setVersion] = useState(0),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [kind, setKind] = useState('PARTIAL_REFUND'),
    [amount, setAmount] = useState('25.00'),
    [message, setMessage] = useState(''),
    [item, setItem] = useState('Replacement item'),
    [shipment, setShipment] = useState(''),
    [question, setQuestion] = useState(
      'Please describe the missing information.',
    ),
    [counter, setCounter] = useState<Offer | null>(null),
    [confirmation, setConfirmation] = useState<{
      offer: Offer;
      settlement?: Settlement;
    } | null>(null),
    [checked, setChecked] = useState(false),
    [next, setNext] = useState<number | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!confirmation) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = window.requestAnimationFrame(() =>
      dialogRef.current?.focus(),
    );
    return () => {
      window.cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, [confirmation]);
  const role = session.memberships.find(
      (m) => m.merchantId === merchantId,
    )?.role,
    approver = ['OWNER', 'APPROVER'].includes(role ?? '');
  async function api<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    v?: number,
  ) {
    const r = await fetch(base + path, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'GET'
          ? {}
          : {
              'x-csrf-token': session.csrfToken,
              'idempotency-key': crypto.randomUUID(),
              ...(v !== undefined ? { 'if-match': String(v) } : {}),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await r.json()) as { data: T; detail?: string };
    if (!r.ok)
      throw Error(
        r.status === 429
          ? 'Too many requests. Wait a minute and retry.'
          : (result.detail ?? 'Request failed'),
      );
    return result.data;
  }
  const refreshSequence = useRef(0);
  async function refresh(more = false) {
    const sequence = ++refreshSequence.current;
    const [r, s] = await Promise.all([
      api<{ items: Offer[]; caseVersion: number; nextCursor: number | null }>(
        `/cases/${caseId}/proposals?limit=25${more && next ? '&cursor=' + next : ''}`,
      ),
      api<Settlement[]>(`/cases/${caseId}/settlements`),
    ]);
    if (sequence !== refreshSequence.current) return;
    setOffers((old) => (more ? [...old, ...r.items] : r.items));
    setVersion(r.caseVersion);
    setNext(r.nextCursor);
    setSettlements(s);
    setLoaded(true);
  }
  useEffect(() => {
    let alive = true;
    void refresh().catch((e) => {
      if (alive) setError(e.message);
    });
    const timer = setInterval(() => {
      if (alive && !confirmation) void refresh().catch(() => {});
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [caseId, session]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, 'POST', body, version);
      setConfirmation(null);
      setChecked(false);
      await refresh();
      await onChanged();
      setNotice('Saved. The case timeline has been updated.');
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }
  const pending = settlements.find(
    (s) => !['CANCELLED', 'FAILED', 'COMPLETED'].includes(s.state),
  );
  async function submit() {
    let minor: string | undefined;
    try {
      if (kind.includes('REFUND')) minor = decimalToMinor(amount).toString();
    } catch {
      setError('Enter a positive USD amount with at most two decimal places.');
      return;
    }
    const expiresAt = new Date(Date.now() + 48 * 3600000).toISOString(),
      body = {
        kind,
        message,
        expiresAt,
        ...(minor ? { amountMinor: minor, currency: 'USD' } : {}),
        ...(kind === 'REPLACEMENT'
          ? {
              itemDescription: item,
              shipBy: new Date(Date.now() + 7 * 86400000).toISOString(),
            }
          : {}),
        ...(kind === 'REQUEST_EVIDENCE' ? { questions: [question] } : {}),
      };
    const ok = await mutate(
      counter
        ? `/cases/${caseId}/proposals/${counter.id}/counter`
        : `/merchants/${merchantId}/cases/${caseId}/proposals`,
      body,
    );
    if (ok) {
      setCounter(null);
      setMessage('');
    }
  }
  async function useAnalysis() {
    setBusy(true);
    setError('');
    try {
      const runs = await api<{ id: string }[]>(
        `/merchants/${merchantId}/cases/${caseId}/analyses?limit=5`,
      );
      if (!runs.length)
        throw Error(
          'No validated analysis is available. You can draft manually.',
        );
      const detail = await api<{
        fresh: boolean;
        revoked: boolean;
        status: string;
        reviews: {
          action: string;
          recommendation: { kind?: string; amountMinor?: string | null };
        }[];
      }>(`/merchants/${merchantId}/cases/${caseId}/analyses/${runs[0]!.id}`);
      const review = detail.reviews.at(-1);
      if (
        !detail.fresh ||
        detail.revoked ||
        !review ||
        !['APPROVE', 'REVISE'].includes(review.action) ||
        !['SUCCEEDED', 'NEEDS_REVIEW'].includes(detail.status)
      )
        throw Error(
          'A fresh, consented, merchant-reviewed recommendation is required.',
        );
      const chosen = review.recommendation,
        mapped =
          chosen.kind === 'REQUEST_MORE_INFORMATION'
            ? 'REQUEST_EVIDENCE'
            : chosen.kind === 'ESCALATE_TO_HUMAN'
              ? 'ESCALATION'
              : chosen.kind;
      if (
        !mapped ||
        ![
          'FULL_REFUND',
          'PARTIAL_REFUND',
          'REPLACEMENT',
          'REQUEST_EVIDENCE',
          'ESCALATION',
        ].includes(mapped)
      )
        throw Error(
          'This recommendation does not map to an offer. Draft manually.',
        );
      setKind(mapped);
      if (chosen.amountMinor)
        setAmount(minorToDecimal(BigInt(chosen.amountMinor)));
      setMessage('Please review this proposed resolution.');
      setNotice(
        'Suggestion copied into an unsent draft. Review all terms; policy checks still apply. No AI request was made.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">
            Resolve together
          </p>
          <h2 className="mt-1 text-2xl font-semibold">
            Negotiation & settlement
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Discuss the case using the messages below. Offers keep their exact
            terms and history. Customer acceptance and separate merchant
            authorization are required before a financial operation.
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          Refresh offers
        </Button>
      </div>
      {synthetic && (
        <p className="my-4 rounded-lg border border-amber-200 bg-amber-50 p-3 font-medium text-amber-900">
          Synthetic demo payment. Refunds on this fixture are mocked; no PayPal
          funds move.
        </p>
      )}
      {error && (
        <p role="alert" className="my-3 rounded bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="my-3 rounded bg-teal-50 p-3 text-teal-900">
          {notice}
        </p>
      )}
      {!loaded ? (
        <p role="status" className="my-4">
          Loading offers and settlement status...
        </p>
      ) : (
        <>
          {settlements.map((s) => (
            <div
              key={s.id}
              className="my-4 rounded-xl border border-teal-200 bg-teal-50 p-4"
              data-testid="settlement-status"
            >
              <h3 className="font-semibold">Settlement: {pretty(s.state)}</h3>
              <p>
                {s.amountMinor ? money(s.amountMinor) : 'Accepted terms'}
                {s.mode === 'mock' ? ' - mock execution' : ''}
              </p>
              {s.refundState && (
                <p>Refund operation: {pretty(s.refundState)}</p>
              )}
              {s.state === 'ACCEPTED' && (
                <p className="mt-2 text-sm">
                  Awaiting separate merchant authorization. No refund has been
                  submitted.
                </p>
              )}
              {s.refundState === 'UNKNOWN' && (
                <p className="mt-2 font-medium">
                  Outcome unknown. Funds remain reserved. Do not issue a second
                  refund; reconciliation or human investigation is required.
                </p>
              )}
              {s.state === 'COMPLETED' && (
                <p className="mt-2 font-medium">
                  {s.mode === 'mock'
                    ? 'Mock refund verified; no PayPal transaction occurred.'
                    : 'The authorized resolution has completed.'}
                </p>
              )}
              {s.providerRefundId && (
                <p className="mt-2 break-all text-xs">
                  Reference: {s.providerRefundId}
                </p>
              )}
              {s.lastErrorCode && (
                <p className="text-sm">Review code: {s.lastErrorCode}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {s.state === 'ACCEPTED' && approver && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const p = offers.find((o) => o.id === s.proposalId);
                      if (p) {
                        setConfirmation({ offer: p, settlement: s });
                        setChecked(false);
                      }
                    }}
                  >
                    Review authorization
                  </Button>
                )}
                {s.state === 'ACCEPTED' && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        `/cases/${caseId}/settlements/${s.id}/cancel`,
                        {
                          reason:
                            'Explicit cancellation before merchant authorization.',
                        },
                      )
                    }
                  >
                    Cancel pending agreement
                  </Button>
                )}
                {approver &&
                  ['UNKNOWN', 'PENDING'].includes(s.refundState ?? '') && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          `/cases/${caseId}/settlements/${s.id}/reconcile`,
                          {},
                        )
                      }
                    >
                      Request reconciliation
                    </Button>
                  )}
              </div>
            </div>
          ))}
          <ol className="my-5 grid gap-4" aria-label="Offer history">
            {offers.map((o) => (
              <li
                key={o.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <h3 className="font-semibold">
                    Offer #{o.sequence}: {pretty(o.kind)}
                  </h3>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase">
                    {pretty(o.effectiveStatus)}
                  </span>
                </div>
                <p className="mt-2 text-xl font-semibold text-slate-900">
                  {money(o.amountMinor)}
                </p>
                <p className="mt-2 whitespace-pre-wrap">{o.terms.message}</p>
                {o.terms.itemDescription && (
                  <p>Replacement: {o.terms.itemDescription}</p>
                )}
                {o.terms.questions?.map((q, i) => (
                  <p key={i}>{q}</p>
                ))}
                <p className="mt-3 text-xs text-slate-500">
                  {o.authorRole === 'CUSTOMER'
                    ? 'Customer counteroffer'
                    : 'Merchant terms'}{' '}
                  - expires {new Date(o.expiresAt).toLocaleString()} - version{' '}
                  {o.rowVersion}
                </p>
                <details className="my-2 text-xs text-slate-500">
                  <summary>Exact offer fingerprint</summary>
                  <code className="break-all">{o.contentHash}</code>
                </details>
                {o.stale && (
                  <p className="text-sm text-amber-800">
                    Case context changed. Fresh terms are required before
                    acceptance or authorization.
                  </p>
                )}
                {settlements
                  .filter(
                    (os) =>
                      os.proposalId === o.id &&
                      os.state === 'FULFILLMENT_PENDING',
                  )
                  .map((os) => (
                    <div key={os.id} className="my-3 rounded bg-white p-3">
                      <p>
                        Replacement fulfillment requires merchant shipment and
                        customer receipt acknowledgment. No refund is involved.
                      </p>
                      {os.shipmentReference && (
                        <p>Shipment reference: {os.shipmentReference}</p>
                      )}
                      {merchant && (
                        <label>
                          Shipment reference
                          <input
                            className={input}
                            value={shipment}
                            maxLength={200}
                            onChange={(e) => setShipment(e.target.value)}
                          />
                          <Button
                            disabled={busy || !shipment.trim()}
                            onClick={() =>
                              void mutate(
                                `/cases/${caseId}/settlements/${os.id}/fulfillment`,
                                { action: 'SHIP', reference: shipment },
                              )
                            }
                          >
                            Record replacement shipment
                          </Button>
                        </label>
                      )}
                      {!merchant && os.shipmentReference && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              `/cases/${caseId}/settlements/${os.id}/fulfillment`,
                              { action: 'RECEIVE' },
                            )
                          }
                        >
                          Confirm replacement received
                        </Button>
                      )}
                    </div>
                  ))}
                <div className="mt-3 flex flex-wrap gap-2">
                  {active &&
                    !pending &&
                    o.effectiveStatus === 'DRAFT' &&
                    o.authorRole === 'MERCHANT' &&
                    approver && (
                      <Button
                        disabled={busy || o.stale}
                        onClick={() =>
                          void mutate(
                            `/cases/${caseId}/proposals/${o.id}/actions`,
                            {
                              action: 'PUBLISH',
                              contentHash: o.contentHash,
                              reason:
                                'Merchant reviewed exact terms and deterministic policy checks.',
                            },
                          )
                        }
                      >
                        Publish offer #{o.sequence}
                      </Button>
                    )}
                  {!merchant &&
                    !pending &&
                    active &&
                    o.status === 'OFFERED' &&
                    o.effectiveStatus !== 'EXPIRED' && (
                      <>
                        <Button
                          disabled={busy || !o.acceptanceAvailable}
                          onClick={() => {
                            setConfirmation({ offer: o });
                            setChecked(false);
                          }}
                        >
                          Review acceptance
                        </Button>
                        <Button
                          disabled={busy || o.stale}
                          onClick={() => {
                            setCounter(o);
                            setKind(o.kind);
                            if (o.amountMinor)
                              setAmount(minorToDecimal(BigInt(o.amountMinor)));
                            setMessage('');
                          }}
                        >
                          Counter offer #{o.sequence}
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              `/cases/${caseId}/proposals/${o.id}/actions`,
                              {
                                action: 'REJECT',
                                contentHash: o.contentHash,
                                reason:
                                  'Customer explicitly rejected these terms.',
                              },
                            )
                          }
                        >
                          Reject offer #{o.sequence}
                        </Button>
                      </>
                    )}
                  {!pending &&
                    ['DRAFT', 'OFFERED'].includes(o.status) &&
                    ((merchant && o.authorRole === 'MERCHANT') ||
                      (!merchant && o.authorRole === 'CUSTOMER')) && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/cases/${caseId}/proposals/${o.id}/actions`,
                            {
                              action:
                                o.effectiveStatus === 'EXPIRED'
                                  ? 'EXPIRE'
                                  : 'WITHDRAW',
                              contentHash: o.contentHash,
                              reason:
                                'Offer author withdrew or expired these terms.',
                            },
                          )
                        }
                      >
                        Withdraw offer #{o.sequence}
                      </Button>
                    )}
                  {merchant &&
                    !pending &&
                    o.authorRole === 'CUSTOMER' &&
                    o.status === 'DRAFT' && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            `/cases/${caseId}/proposals/${o.id}/actions`,
                            {
                              action: 'REJECT',
                              contentHash: o.contentHash,
                              reason:
                                'Merchant rejected the counteroffer; revised terms may follow.',
                            },
                          )
                        }
                      >
                        Reject counter #{o.sequence}
                      </Button>
                    )}
                </div>
              </li>
            ))}
          </ol>
          {!offers.length && (
            <p className="my-5 text-slate-500">
              No offers yet. Continue the discussion or prepare the first
              reviewed proposal.
            </p>
          )}
          {next && (
            <Button
              onClick={() =>
                void refresh(true).catch((e) => setError(e.message))
              }
            >
              Earlier offers
            </Button>
          )}
          {confirmation && (
            <section
              ref={dialogRef}
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !busy) setConfirmation(null);
              }}
              role="dialog"
              aria-modal="false"
              aria-labelledby="settlement-confirm-title"
              className="my-5 rounded-xl border-2 border-teal-700 bg-teal-50 p-5"
            >
              <h3
                id="settlement-confirm-title"
                className="text-xl font-semibold"
              >
                {confirmation.settlement
                  ? 'Authorize this exact settlement'
                  : 'Confirm acceptance of these exact terms'}
              </h3>
              <p className="my-3 font-semibold">
                Offer #{confirmation.offer.sequence}:{' '}
                {pretty(confirmation.offer.kind)} -{' '}
                {money(confirmation.offer.amountMinor)}
              </p>
              <p className="whitespace-pre-wrap">
                {confirmation.offer.terms.message}
              </p>
              <p className="my-3 text-sm">
                {confirmation.settlement
                  ? 'This authorizes one durable operation against the captured payment. An unknown result retains its reservation; never create a replacement refund.'
                  : 'Acceptance records your consent to this offer version. A separate authorized merchant must approve execution. No refund occurs from this button alone.'}
              </p>
              {synthetic && (
                <p className="font-semibold text-amber-900">
                  Synthetic fixture: execution is mocked.
                </p>
              )}
              <label className="my-4 flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                I have reviewed the amount, remedy, terms and exact offer
                version.
              </label>
              <div className="flex gap-3">
                <Button
                  disabled={busy || !checked}
                  onClick={() =>
                    void mutate(
                      confirmation.settlement
                        ? `/cases/${caseId}/settlements/${confirmation.settlement.id}/authorize`
                        : `/cases/${caseId}/proposals/${confirmation.offer.id}/accept`,
                      {
                        contentHash: confirmation.offer.contentHash,
                        proposalVersion: confirmation.offer.rowVersion,
                        confirm: true,
                      },
                    )
                  }
                >
                  {confirmation.settlement
                    ? 'Confirm merchant authorization'
                    : 'Confirm customer acceptance'}
                </Button>
                <Button disabled={busy} onClick={() => setConfirmation(null)}>
                  Back to offers
                </Button>
              </div>
            </section>
          )}
          {active && !pending && (merchant || counter) && (
            <form
              className="my-5 grid gap-4 rounded-xl bg-slate-50 p-5"
              aria-label={
                counter ? 'Customer counteroffer' : 'Merchant offer draft'
              }
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <h3 className="text-lg font-semibold">
                {counter
                  ? `Counter offer #${counter.sequence}`
                  : 'Prepare an unsent offer draft'}
              </h3>
              {merchant && (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void useAnalysis()}
                >
                  Use reviewed AI suggestion
                </Button>
              )}
              <p className="text-sm text-slate-600">
                Human-authored terms. Every submission is checked against the
                purchase policy and available balance. Legacy policies do not
                create refund entitlement.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  Remedy
                  <select
                    className={input}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    {[
                      'PARTIAL_REFUND',
                      'FULL_REFUND',
                      'REPLACEMENT',
                      'REQUEST_EVIDENCE',
                      'ESCALATION',
                    ].map((k) => (
                      <option key={k} value={k}>
                        {pretty(k)}
                      </option>
                    ))}
                  </select>
                </label>
                {kind.includes('REFUND') && (
                  <label>
                    Amount (USD)
                    <input
                      className={input}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </label>
                )}
              </div>
              {kind === 'REPLACEMENT' && (
                <label>
                  Replacement description
                  <input
                    className={input}
                    value={item}
                    onChange={(e) => setItem(e.target.value)}
                    required
                    maxLength={500}
                  />
                </label>
              )}
              {kind === 'REQUEST_EVIDENCE' && (
                <label>
                  Question
                  <input
                    className={input}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    required
                    maxLength={500}
                  />
                </label>
              )}
              <label>
                Customer-visible terms
                <textarea
                  className={input}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  required
                  minLength={5}
                  maxLength={2000}
                  rows={3}
                />
              </label>
              <p className="text-xs text-slate-500">
                Expires 48 hours after submission. Replacement shipping
                deadline: seven days. Drafts remain private until an approver
                publishes them.
              </p>
              <div className="flex gap-3">
                <Button disabled={busy} type="submit">
                  {counter ? 'Submit counteroffer' : 'Save private draft'}
                </Button>
                {counter && (
                  <Button type="button" onClick={() => setCounter(null)}>
                    Cancel counter
                  </Button>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </Card>
  );
}
