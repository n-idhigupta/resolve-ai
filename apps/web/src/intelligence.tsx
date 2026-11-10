import { useEffect, useState } from 'react';
import type { AIOutput } from '@resolveai/shared';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
type Session = {
  user: { id: string; email: string };
  csrfToken: string;
  memberships: { merchantId: string; role: string }[];
};
type Config = {
  executionMode?: 'mock' | 'external';
  provider: 'openai' | 'gemini';
  syntheticOnly: boolean;
  configured: boolean;
  enabled: boolean;
  model: string;
  disclosure: string;
};
type Consent = {
  id: string;
  contextId: string;
  sharingPolicyId: string;
  consentHash: string;
  revoked: boolean;
  createdAt: string;
};
type Candidate = {
  id: string;
  kind: string;
  amountMinor: string | null;
  currency: string | null;
};
type Preview = {
  executionMode?: 'mock' | 'external';
  providerId?: string;
  providerRequest?: unknown;
  tokenCountRequest?: unknown;
  id: string;
  state: string;
  errorCode: string | null;
  sharingPolicyId: string;
  consentHash: string;
  disclosure: string;
  modelId: string;
  request: {
    model: string;
    instructions: string;
    input: {
      role: string;
      content: { type: string; text?: string; image_url?: string }[];
    }[];
    store: boolean;
    text: unknown;
  } | null;
};
type Analysis = {
  executionMode?: 'mock' | 'external';
  id: string;
  status: string;
  version: number;
  fresh: boolean;
  revoked: boolean;
  modelId: string;
  promptVersion: string;
  lastErrorCode: string | null;
  createdAt: string;
  usage: { estimatedMicros?: number } | null;
  result: AIOutput | null;
  constraints: {
    candidates: Candidate[];
    remainingMinor: string;
    missingEvidenceTypes: string[];
    requiresHumanReview: boolean;
  } | null;
  verifiedFacts: { key: string; text: string }[];
  reviews: {
    id: string;
    action: string;
    reason: string;
    recommendation: Candidate;
    createdAt: string;
  }[];
};
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(
  /\/$/,
  '',
);
async function call<T>(
  path: string,
  session: Session,
  options?: { body: unknown; version?: number },
) {
  const r = await fetch(base + path, {
    credentials: 'include',
    method: options ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options
        ? {
            'x-csrf-token': session.csrfToken,
            'idempotency-key': crypto.randomUUID(),
          }
        : {}),
      ...(options?.version !== undefined
        ? { 'if-match': String(options.version) }
        : {}),
    },
    ...(options ? { body: JSON.stringify(options.body) } : {}),
  });
  const b = (await r.json()) as { data: T; detail?: string };
  if (!r.ok)
    throw Error(
      r.status === 429
        ? 'Too many requests. Retry after ' +
            (r.headers.get('retry-after') ?? '60') +
            ' seconds.'
        : (b.detail ?? 'AI request failed'),
    );
  return b.data;
}
const label = (s: string) => s.replaceAll('_', ' ').toLowerCase();
const field = 'w-full rounded border border-slate-300 bg-white p-2';
function candidateText(c: Candidate) {
  if (c.amountMinor == null) return label(c.kind);
  const n = BigInt(c.amountMinor);
  return `${label(c.kind)} · ${c.currency} ${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
}
export function IntelligencePanel({
  session,
  caseId,
  merchantId,
  caseVersion,
  merchant,
  files,
  active,
}: {
  session: Session;
  caseId: string;
  merchantId: string;
  caseVersion: number;
  merchant: boolean;
  files: {
    id: string;
    filename: string;
    scanStatus: string;
    uploadState: string;
  }[];
  active: boolean;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [consents, setConsents] = useState<Consent[]>([]),
    [history, setHistory] = useState<
      { id: string; status: string; createdAt: string }[]
    >([]),
    [analysis, setAnalysis] = useState<Analysis | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [selection, setSelection] = useState<string[]>([]),
    [ack, setAck] = useState(false),
    [policyEnabled, setPolicyEnabled] = useState(false),
    [policyAck, setPolicyAck] = useState(false),
    [reason, setReason] = useState(''),
    [rationale, setRationale] = useState(''),
    [candidateId, setCandidateId] = useState(''),
    [citation, setCitation] = useState<{
      key: string;
      kind: string;
      text: string;
      page: number | null;
    } | null>(null),
    [comparison, setComparison] = useState<Analysis | null>(null),
    [usage, setUsage] = useState<{
      daily: { day: string; committedMicros: string }[];
    } | null>(null);
  const root = `/merchants/${merchantId}/cases/${caseId}/analyses`,
    owner = session.memberships.some(
      (m) => m.merchantId === merchantId && m.role === 'OWNER',
    ),
    approver = session.memberships.some(
      (m) =>
        m.merchantId === merchantId && ['OWNER', 'APPROVER'].includes(m.role),
    );
  async function refresh() {
    const current = await call<Config>(`/ai/config?caseId=${caseId}`, session);
    setConfig(current);
    setConsents(await call<Consent[]>(`/cases/${caseId}/ai-consents`, session));
    if (merchant) {
      setHistory(await call<typeof history>(root, session));
      const policies = await call<{ enabled: boolean; modelId: string }[]>(
        `/merchants/${merchantId}/ai-sharing-policies`,
        session,
      );
      setPolicyEnabled(
        !!policies[0]?.enabled && policies[0]?.modelId === current.model,
      );
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [caseId, session, merchant]);
  useEffect(() => {
    if (!preview || !['QUEUED', 'PREPARING'].includes(preview.state)) return;
    const timer = setInterval(() => {
      void call<Preview>(
        `/cases/${caseId}/ai-sharing-previews/${preview.id}`,
        session,
      )
        .then(setPreview)
        .catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [preview?.id, preview?.state, caseId, session]);
  useEffect(() => {
    if (!analysis || !['QUEUED', 'RUNNING'].includes(analysis.status)) return;
    const timer = setInterval(() => {
      void call<Analysis>(root + '/' + analysis.id, session)
        .then(setAnalysis)
        .catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(timer);
  }, [analysis?.id, analysis?.status, session, root]);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const latest = consents.find((c) => !c.revoked);
  async function review(action: 'APPROVE' | 'REJECT' | 'REVISE') {
    if (!analysis) return;
    await call(root + '/' + analysis.id + '/reviews', session, {
      version: analysis.version,
      body: {
        action,
        reason,
        rationale:
          rationale ||
          analysis.result?.recommendation.rationale ||
          'Internal review only.',
        candidateId: action === 'REVISE' ? candidateId : null,
      },
    });
    setAnalysis(await call<Analysis>(root + '/' + analysis.id, session));
    setError(
      'Internal decision recorded. No customer offer, case closure, payment or refund was created.',
    );
  }
  if (!config)
    return (
      <Card>
        <h2 className="text-xl font-semibold">AI resolution intelligence</h2>
        <p role="status">{error || 'Checking AI configuration…'}</p>
      </Card>
    );
  return (
    <Card>
      <h2 className="text-xl font-semibold">AI resolution intelligence</h2>
      {config.executionMode === 'mock' && (
        <p className="my-3 rounded-lg bg-amber-100 p-3 font-medium text-amber-950">
          Local deterministic mock. No external model call or provider-quality
          claim.
        </p>
      )}
      <p className="my-3 text-sm text-slate-600">
        Nonbinding merchant assistance. AI cannot issue refunds, send offers or
        close cases.
      </p>
      {!config.enabled && (
        <p className="my-3 rounded bg-amber-50 p-3">
          Real AI inference is disabled or its server key is unavailable. Manual
          case handling remains available. Consent previews are local
          preparation only.
        </p>
      )}
      {config.syntheticOnly && config.provider === 'gemini' && (
        <p className="my-3 rounded bg-amber-50 p-3">
          Google unpaid mode accepts only trusted synthetic test cases. Real
          customer or confidential data is prohibited even with consent. Account
          eligibility and real-provider verification remain separate
          prerequisites.
        </p>
      )}
      {!merchant && (
        <>
          <p className="my-3">
            {config.executionMode === 'mock'
              ? 'You control the exact synthetic case content processed by the local mock. Nothing is sent to an external provider. Private merchant notes are excluded.'
              : 'You control whether selected case text and evidence may be sent to the configured provider. Private merchant notes are never included.'}{' '}
            Internal findings are visible only to the merchant.
          </p>
          <fieldset className="my-3 grid gap-2">
            <legend>Select clean evidence for sharing</legend>
            {files
              .filter(
                (f) =>
                  f.scanStatus === 'CLEAN' && f.uploadState === 'AVAILABLE',
              )
              .map((f) => (
                <label key={f.id}>
                  <input
                    type="checkbox"
                    checked={selection.includes(f.id)}
                    onChange={(e) => {
                      setSelection(
                        e.target.checked
                          ? [...selection, f.id]
                          : selection.filter((id) => id !== f.id),
                      );
                      setPreview(null);
                      setAck(false);
                    }}
                  />{' '}
                  {f.filename}
                </label>
              ))}
          </fieldset>
          <Button
            disabled={busy || !active || !config.configured}
            onClick={() =>
              void task(async () => {
                setAck(false);
                setPreview(
                  await call<Preview>(
                    `/cases/${caseId}/ai-sharing-previews`,
                    session,
                    { body: { evidenceIds: selection } },
                  ),
                );
              })
            }
          >
            Prepare sharing preview
          </Button>
          {preview && (
            <section className="my-4 rounded border p-3">
              <p role="status">
                Preview: {label(preview.state)} {preview.errorCode ?? ''}
              </p>
              {preview.state === 'READY' && preview.request && (
                <>
                  <p className="my-3">{preview.disclosure}</p>
                  <p className="text-sm">
                    Provider:{' '}
                    {preview.executionMode === 'mock'
                      ? 'Local deterministic mock'
                      : preview.providerId === 'gemini'
                        ? 'Google Gemini'
                        : 'OpenAI'}{' '}
                    · Model: {preview.modelId} · Sharing policy{' '}
                    {preview.sharingPolicyId}
                  </p>
                  <h3 className="mt-4 font-semibold">
                    {preview.executionMode === 'mock'
                      ? 'Exact locally processed case content (nothing transmitted)'
                      : 'Exact externally transmitted case content'}
                  </h3>
                  {preview.request.input
                    .flatMap((m) => m.content)
                    .map((content, i) =>
                      content.type === 'input_image' ? (
                        <img
                          key={i}
                          className="my-3 max-h-96 max-w-full"
                          src={content.image_url}
                          alt={'Evidence derivative ' + (i + 1)}
                        />
                      ) : (
                        <pre
                          key={i}
                          className="my-3 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs"
                        >
                          {content.text}
                        </pre>
                      ),
                    )}
                  {preview.providerId === 'gemini' && (
                    <details>
                      <summary>
                        Exact Google SDK generation and token-count arguments
                        (authentication excluded)
                      </summary>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
                        {JSON.stringify(
                          {
                            generation: preview.providerRequest,
                            tokenCounting: preview.tokenCountRequest,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                  <details>
                    <summary>
                      Instructions and complete request structure
                    </summary>
                    <p className="my-3 whitespace-pre-wrap text-sm">
                      {preview.request.instructions}
                    </p>
                    <pre className="max-h-80 overflow-auto text-xs">
                      {JSON.stringify(
                        {
                          ...preview.request,
                          input: preview.request.input.map((m) => ({
                            ...m,
                            content: m.content.map((c) =>
                              c.image_url
                                ? {
                                    ...c,
                                    image_url:
                                      '[image derivative displayed above]',
                                  }
                                : c,
                            ),
                          })),
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  <label className="my-4 block">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />{' '}
                    {preview.executionMode === 'mock'
                      ? 'I reviewed this exact local-only mock processing disclosure and consent to this policy and source manifest.'
                      : 'I reviewed this exact content and provider-retention disclosure and consent to this sharing policy and source manifest.'}
                  </label>
                  <Button
                    disabled={!ack || busy}
                    onClick={() =>
                      void task(async () => {
                        await call(`/cases/${caseId}/ai-consents`, session, {
                          body: {
                            contextId: preview.id,
                            sharingPolicyId: preview.sharingPolicyId,
                            consentHash: preview.consentHash,
                          },
                        });
                        await refresh();
                        setError(
                          'Consent recorded. The merchant may request this exact analysis.',
                        );
                      })
                    }
                  >
                    Consent to this preview
                  </Button>
                </>
              )}
              {preview.state === 'STALE' && (
                <p>
                  The case changed. Prepare a new preview before consenting.
                </p>
              )}
            </section>
          )}
          <h3 className="mt-5 font-semibold">Sharing history</h3>
          {consents.map((c) => (
            <div key={c.id} className="my-2 flex flex-wrap gap-3">
              <span>
                {new Date(c.createdAt).toLocaleString()} ·{' '}
                {c.revoked ? 'Revoked' : 'Consented'}
              </span>
              {!c.revoked && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      await call(
                        `/cases/${caseId}/ai-consents/${c.id}/revoke`,
                        session,
                        { body: {} },
                      );
                      // The mutation is confirmed even if a subsequent read is rate-limited.
                      setConsents((rows) =>
                        rows.map((row) =>
                          row.id === c.id ? { ...row, revoked: true } : row,
                        ),
                      );
                      const notice =
                        'Future transmissions revoked. Already dispatched data cannot be recalled.';
                      setError(notice);
                      try {
                        await refresh();
                      } catch (e) {
                        setError(
                          notice +
                            ' Status refresh unavailable: ' +
                            (e as Error).message,
                        );
                      }
                    })
                  }
                >
                  Revoke consent
                </Button>
              )}
            </div>
          ))}
        </>
      )}
      {merchant && (
        <>
          {owner && !policyEnabled && (
            <section className="my-4 rounded border p-3">
              <p>{config.disclosure}</p>
              <label className="my-3 block">
                <input
                  type="checkbox"
                  checked={policyAck}
                  onChange={(e) => setPolicyAck(e.target.checked)}
                />{' '}
                Enable this versioned{' '}
                {config.executionMode === 'mock'
                  ? 'local mock'
                  : config.provider === 'gemini'
                    ? 'Google Gemini (synthetic only)'
                    : 'OpenAI'}{' '}
                sharing policy. Customers must still consent per case.
              </label>
              <Button
                disabled={!policyAck || busy}
                onClick={() =>
                  void task(async () => {
                    await call(
                      `/merchants/${merchantId}/ai-sharing-policies`,
                      session,
                      {
                        body: {
                          enabled: true,
                          modelId: config.model,
                          dailyBudgetMicros: 5000000,
                        },
                      },
                    );
                    await refresh();
                  })
                }
              >
                Enable AI sharing policy
              </Button>
            </section>
          )}
          <p className="my-3">
            {latest
              ? 'A customer consent record is available; the server rechecks freshness before processing.'
              : 'Waiting for the customer to consent to a prepared source manifest.'}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={
                busy || !config.enabled || !policyEnabled || !latest || !active
              }
              onClick={() =>
                void task(async () => {
                  const result = await call<{ id: string }>(root, session, {
                    version: caseVersion,
                    body: { consentId: latest!.id },
                  });
                  setAnalysis(
                    await call<Analysis>(root + '/' + result.id, session),
                  );
                  await refresh();
                })
              }
            >
              Request AI analysis
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await refresh();
                  if (analysis)
                    setAnalysis(
                      await call<Analysis>(root + '/' + analysis.id, session),
                    );
                })
              }
            >
              Refresh AI status
            </Button>
            <Button
              onClick={() =>
                void task(async () =>
                  setUsage(
                    await call(`/merchants/${merchantId}/ai-usage`, session),
                  ),
                )
              }
            >
              View AI usage
            </Button>
          </div>
          {usage && (
            <p className="my-3 text-sm">
              Estimated committed usage:{' '}
              {usage.daily
                .map(
                  (d) =>
                    `${d.day.slice(0, 10)}: USD ${(Number(d.committedMicros) / 1000000).toFixed(4)}`,
                )
                .join('; ') || 'None'}
              . Unknown attempts retain budget reservations.
            </p>
          )}
          <div className="my-4 grid gap-3 md:grid-cols-2">
            <label>
              Analysis history
              <select
                className={field}
                aria-label="Analysis history"
                value={analysis?.id ?? ''}
                onChange={(e) =>
                  void task(async () =>
                    setAnalysis(
                      await call<Analysis>(
                        root + '/' + e.target.value,
                        session,
                      ),
                    ),
                  )
                }
              >
                <option value="">Select an analysis</option>
                {history.map((h) => (
                  <option key={h.id} value={h.id}>
                    {new Date(h.createdAt).toLocaleString()} · {label(h.status)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Compare historical analysis
              <select
                className={field}
                aria-label="Compare historical analysis"
                value={comparison?.id ?? ''}
                onChange={(e) => {
                  if (e.target.value)
                    void task(async () =>
                      setComparison(
                        await call<Analysis>(
                          root + '/' + e.target.value,
                          session,
                        ),
                      ),
                    );
                  else setComparison(null);
                }}
              >
                <option value="">No comparison</option>
                {history.map((h) => (
                  <option key={h.id} value={h.id}>
                    {new Date(h.createdAt).toLocaleString()} · {label(h.status)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {analysis && (
            <section className="my-4 rounded border p-4">
              <p role="status">AI analysis: {label(analysis.status)}</p>
              <p className="text-xs">
                {analysis.modelId} · {analysis.promptVersion}
              </p>
              {(!analysis.fresh || analysis.revoked) && (
                <p className="my-3 rounded bg-amber-50 p-3">
                  Stale or revoked analysis. It cannot be approved. Prepare new
                  consented inputs and request reanalysis.
                </p>
              )}
              {analysis.lastErrorCode && (
                <p>
                  {label(analysis.lastErrorCode)}. Continue manual
                  investigation.
                </p>
              )}
              <h3 className="mt-4 font-semibold">
                Verified facts from ResolveAI records
              </h3>
              {analysis.verifiedFacts.map((f) => (
                <p className="my-2 text-sm" key={f.key}>
                  {f.text}
                </p>
              ))}
              {analysis.result && (
                <>
                  <h3 className="mt-4 font-semibold">Case summary</h3>
                  <p>{analysis.result.summary.text}</p>
                  {(
                    [
                      'ALLEGATION',
                      'EVIDENCE_OBSERVATION',
                      'UNCERTAINTY',
                    ] as const
                  ).map((kind) => (
                    <section key={kind}>
                      <h3 className="mt-4 font-semibold">{label(kind)}</h3>
                      {analysis
                        .result!.findings.filter((f) => f.kind === kind)
                        .map((f) => (
                          <article
                            key={f.id}
                            className="my-2 rounded bg-slate-50 p-3"
                          >
                            <p>{f.statement}</p>
                            <div className="flex gap-2">
                              {f.sourceIds.map((source) => (
                                <button
                                  className="text-sm text-teal-800 underline"
                                  key={source}
                                  onClick={() =>
                                    void task(async () =>
                                      setCitation(
                                        await call(
                                          root +
                                            '/' +
                                            analysis.id +
                                            '/sources/' +
                                            source,
                                          session,
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  {source}
                                </button>
                              ))}
                            </div>
                          </article>
                        ))}
                    </section>
                  ))}
                  <h3 className="mt-4 font-semibold">
                    Contradictions and missing information
                  </h3>
                  {analysis.result.contradictions.map((c, i) => (
                    <p key={i}>{c.explanation}</p>
                  ))}
                  {analysis.result.missingInformation.map((m, i) => (
                    <p key={i}>
                      {m.question} — {m.reason}
                    </p>
                  ))}
                  <h3 className="mt-4 font-semibold">
                    Suggested remedy (nonbinding)
                  </h3>
                  <p>
                    {candidateText(
                      analysis.constraints?.candidates.find(
                        (c) =>
                          c.id === analysis.result!.recommendation.candidateId,
                      ) ?? {
                        id: '',
                        kind: 'ESCALATE_TO_HUMAN',
                        amountMinor: null,
                        currency: null,
                      },
                    )}
                  </p>
                  <p>{analysis.result.recommendation.rationale}</p>
                </>
              )}
              {analysis.constraints && (
                <>
                  <h3 className="mt-4 font-semibold">
                    Policy-permitted candidates
                  </h3>
                  <ul>
                    {analysis.constraints.candidates.map((c) => (
                      <li key={c.id}>{candidateText(c)}</li>
                    ))}
                  </ul>
                  {analysis.constraints.missingEvidenceTypes.length > 0 && (
                    <p>
                      Missing required evidence:{' '}
                      {analysis.constraints.missingEvidenceTypes.join(', ')}
                    </p>
                  )}
                </>
              )}
              <h3 className="mt-4 font-semibold">Internal merchant decision</h3>
              <label>
                Review reason
                <textarea
                  className={field}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                Explanation
                <textarea
                  className={field}
                  maxLength={2000}
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                />
              </label>
              {approver && analysis.constraints && (
                <label>
                  Revised policy-permitted remedy
                  <select
                    aria-label="Revised remedy"
                    className={field}
                    value={candidateId}
                    onChange={(e) => setCandidateId(e.target.value)}
                  >
                    <option value="">Select a candidate</option>
                    {analysis.constraints.candidates.map((c) => (
                      <option value={c.id} key={c.id}>
                        {candidateText(c)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="mt-3 flex flex-wrap gap-3">
                <Button
                  disabled={busy || reason.trim().length < 5}
                  onClick={() => void task(() => review('REJECT'))}
                >
                  Reject internally
                </Button>
                {approver && (
                  <>
                    <Button
                      disabled={
                        busy ||
                        reason.trim().length < 5 ||
                        !analysis.fresh ||
                        analysis.revoked ||
                        !analysis.result
                      }
                      onClick={() => void task(() => review('APPROVE'))}
                    >
                      Approve internal recommendation
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        reason.trim().length < 5 ||
                        !candidateId ||
                        !analysis.fresh ||
                        analysis.revoked ||
                        !analysis.result
                      }
                      onClick={() => void task(() => review('REVISE'))}
                    >
                      Record policy-checked revision
                    </Button>
                  </>
                )}
              </div>
              <p className="my-3 text-sm">
                Approval records an internal decision only. It sends no offer
                and changes no case or payment state.
              </p>
              {analysis.reviews.map((r) => (
                <article className="my-2 rounded border p-2" key={r.id}>
                  <strong>{label(r.action)}</strong>
                  <p>{r.reason}</p>
                  <p>{candidateText(r.recommendation)}</p>
                </article>
              ))}
            </section>
          )}
          {citation && (
            <aside
              className="my-3 rounded border border-teal-300 p-3"
              aria-label="Validated citation"
            >
              <h3>
                {citation.key} · {label(citation.kind)}{' '}
                {citation.page ? '· page ' + citation.page : ''}
              </h3>
              <p className="whitespace-pre-wrap">{citation.text}</p>
              <Button onClick={() => setCitation(null)}>Close citation</Button>
            </aside>
          )}
          {comparison && (
            <aside className="my-3 rounded border p-3">
              <h3>Historical comparison</h3>
              <p>
                {label(comparison.status)} · {comparison.modelId} ·{' '}
                {comparison.promptVersion}
              </p>
              <p>{comparison.result?.summary.text ?? 'No validated output.'}</p>
              <p>{comparison.result?.recommendation.rationale}</p>
            </aside>
          )}
        </>
      )}
      <p role="status" className="mt-4">
        {error}
      </p>
    </Card>
  );
}
