import { MOCK_DISCLOSURE } from './mock.js';
import { providerForModel, GEMINI_DISCLOSURE } from './selection.js';
import { geminiWire, geminiCountWire } from './gemini-wire.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentDatabase,
  encryptReceipt,
  decryptReceipt,
  hashPayload,
  type Tx,
} from '@resolveai/payment-store';
import {
  CaseStore,
  member,
  event,
  fail,
  replay,
  remember,
  type Actor,
} from '@resolveai/case-store';
import {
  aiSharingSchema,
  aiSelectionSchema,
  aiReviewSchema,
  activeCaseStates,
} from '@resolveai/shared';
import {
  complaintPolicy,
  recommendationCandidates,
  chooseRecommendation,
  type RecommendationCandidate,
} from '@resolveai/policy-engine';
import {
  MODEL,
  PROMPT_VERSION,
  requestEnvelope,
  type ProviderInput,
} from './provider.js';
import {
  redact,
  sourceSchema,
  outputUncertain,
  type AISource,
} from './contracts.js';
export const DISCLOSURE =
  'OpenAI will receive the exact request shown in this preview, including selected redacted case text and selected evidence derivatives. Images may still contain visible personal data. Requests use store:false, but provider abuse-monitoring retention may apply (normally up to 30 days). AI results are merchant-only, nonbinding and never execute payments. Consent may be revoked for future requests; data already transmitted cannot be recalled.';
export const PRICE_VERSION = 'openai-mini-standard-2026-11-10';
export type BaseContext = {
  sources: AISource[];
  caseSummary: { reason: string; requestedOutcome: string };
  policy: {
    legacy: boolean;
    eligible: boolean;
    allowedRemedies: string[];
    maxPartialRefundBps: number | null;
    potentialRefundCapMinor: string | null;
    requiredEvidenceTypes: string[];
    reviewReasons: string[];
  };
  money: {
    gross: string;
    refunded: string;
    external: string;
    reserved: string;
    current: boolean;
  };
  selected: { id: string; key: string; hash: string; mime: string }[];
  omissions: string[];
};
export function candidatesFor(
  base: BaseContext,
  availableTypes: string[],
  omissions: string[],
) {
  return recommendationCandidates({
    ...base.policy,
    availableEvidenceTypes: availableTypes,
    omissions: omissions.length > 0,
    current: base.money.current,
    gross: BigInt(base.money.gross),
    refunded: BigInt(base.money.refunded),
    external: BigInt(base.money.external),
    reserved: BigInt(base.money.reserved),
  });
}
export class IntelligenceService {
  readonly cases: CaseStore;
  constructor(
    readonly db: PaymentDatabase,
    readonly encryptionKey: string,
  ) {
    if (!/^[a-f0-9]{64}$/.test(encryptionKey))
      throw Error('AI_ENCRYPTION_KEY_REQUIRED');
    this.cases = new CaseStore(db);
  }
  tx<T>(a: Actor, fn: (tx: Tx) => Promise<T>) {
    return this.db.transaction(a.merchantId, a.userId, fn);
  }
  async lockSources(tx: Tx, a: Actor, caseId: string) {
    await tx.query(
      'SELECT p.id FROM "Capture" p JOIN "Case" c ON c."orderId"=p."orderId" AND c."merchantId"=p."merchantId" WHERE c.id=$1 FOR SHARE OF p',
      [caseId],
    );
    const c = await this.cases.locked(tx, a, caseId);
    await tx.query(
      'SELECT id FROM "Evidence" WHERE "caseId"=$1 ORDER BY id FOR SHARE',
      [caseId],
    );
    return c;
  }
  async sharingPolicy(a: Actor, input: unknown) {
    const body = aiSharingSchema.parse(input);
    const providerId = providerForModel(body.modelId);
    const externalDisclosure =
      providerId === 'gemini' ? GEMINI_DISCLOSURE : DISCLOSURE;
    return this.tx(a, async (tx) => {
      if ((await member(tx, a)) !== 'OWNER') fail('FORBIDDEN', 403);
      const mock = !!(
        await tx.query(
          'SELECT "merchantId" FROM "DemoTenant" WHERE "merchantId"=$1',
          [a.merchantId],
        )
      ).rows[0];
      if (mock && body.modelId !== 'gpt-5.4-mini-2026-03-17')
        fail('MOCK_MODEL_REQUIRED', 422);
      const executionMode = mock ? 'mock' : 'external',
        disclosure = mock ? MOCK_DISCLOSURE : externalDisclosure;
      await tx.query('SELECT id FROM "Merchant" WHERE id=$1 FOR UPDATE', [
        a.merchantId,
      ]);
      const n = (
        await tx.query(
          'SELECT COALESCE(max(sequence),0)+1 n FROM "AISharingPolicy"',
        )
      ).rows[0].n;
      const row = (
        await tx.query(
          'INSERT INTO "AISharingPolicy"("merchantId",sequence,"modelId",enabled,"dailyBudgetMicros","policyHash",disclosure,"providerId","executionMode") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            a.merchantId,
            n,
            body.modelId,
            body.enabled,
            body.dailyBudgetMicros,
            hashPayload({ ...body, disclosure, providerId, executionMode }),
            disclosure,
            providerId,
            executionMode,
          ],
        )
      ).rows[0];
      await tx.query(
        'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType","actorId",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'AISharingPolicy\',$2,\'USER\',$3,\'AI_SHARING_POLICY_CHANGED\',\'INTERNAL\',$4,$5)',
        [
          a.merchantId,
          row.id,
          a.userId,
          randomUUID(),
          JSON.stringify({ sequence: n, enabled: body.enabled }),
        ],
      );
      return row;
    });
  }
  async base(tx: Tx, a: Actor, caseId: string, selectedIds: string[]) {
    const c = await this.lockSources(tx, a, caseId);
    if (!(activeCaseStates as readonly string[]).includes(c.status))
      fail('CASE_CLOSED');
    const order = (
      await tx.query('SELECT * FROM "Order" WHERE id=$1', [c.orderId])
    ).rows[0];
    const capture = (
      await tx.query('SELECT * FROM "Capture" WHERE "orderId"=$1', [c.orderId])
    ).rows[0];
    if (!capture?.verifiedAt) fail('VERIFIED_PAYMENT_REQUIRED');
    const all = (
      await tx.query(
        'SELECT id,"objectKey","cleanObjectKey",sha256,"detectedType","scanStatus","uploadState","scannedAt" FROM "Evidence" WHERE "caseId"=$1 ORDER BY id',
        [caseId],
      )
    ).rows;
    const selected = selectedIds.map((id) => {
      const e = all.find((e) => e.id === id);
      if (
        !e ||
        e.scanStatus !== 'CLEAN' ||
        e.uploadState !== 'AVAILABLE' ||
        !e.scannedAt ||
        !e.cleanObjectKey
      )
        fail('EVIDENCE_UNAVAILABLE');
      return {
        id,
        key: e.cleanObjectKey as string,
        hash: e.sha256 as string,
        mime: e.detectedType as string,
      };
    });
    const clauses = (
      await tx.query(
        'SELECT * FROM "PolicyClause" WHERE "policyVersionId"=$1 ORDER BY "clauseKey"',
        [c.policyVersionId],
      )
    ).rows;
    let evaluated;
    try {
      evaluated = complaintPolicy(
        clauses.map((c) => c.rulesJson),
        c.reason,
        capture.completedAt,
        c.createdAt,
        BigInt(capture.grossMinor),
      );
    } catch {
      evaluated = complaintPolicy(
        [],
        c.reason,
        capture.completedAt,
        c.createdAt,
        BigInt(capture.grossMinor),
      );
    }
    const policy = {
      legacy: evaluated.legacy,
      eligible: evaluated.eligible,
      allowedRemedies:
        'allowedRemedies' in evaluated ? evaluated.allowedRemedies : [],
      maxPartialRefundBps:
        'maxPartialRefundBps' in evaluated
          ? evaluated.maxPartialRefundBps
          : null,
      potentialRefundCapMinor:
        'potentialRefundCapMinor' in evaluated
          ? evaluated.potentialRefundCapMinor
          : null,
      requiredEvidenceTypes: evaluated.requiredEvidenceTypes,
      reviewReasons: evaluated.reviewReasons,
    };
    const sources: AISource[] = [];
    function add(
      kind: AISource['kind'],
      text: string,
      reference: Record<string, string>,
      page: number | null = null,
    ) {
      const redacted = redact(text);
      sources.push({
        key: 'S' + String(sources.length + 1).padStart(3, '0'),
        kind,
        text: redacted,
        reference,
        page,
        hash: hashPayload(redacted),
      });
    }
    add(
      'ALLEGATION',
      `${c.title}\n${c.description}\nRequested outcome: ${c.requestedOutcome}\n${c.desiredResolution}`,
      { caseSourceId: caseId },
    );
    add(
      'TRUSTED_RECORD',
      `Verified captured amount: USD ${capture.grossMinor} minor units. Capture status: ${capture.providerStatus}. Reconciliation: ${capture.reconciliationStatus}.`,
      { captureId: capture.id, recordField: 'verifiedPayment' },
    );
    add(
      'TRUSTED_RECORD',
      `Order amount: USD ${order.amountMinor} minor units. Order status: ${order.status}.`,
      { orderId: order.id, recordField: 'orderTotal' },
    );
    const comments = (
      await tx.query(
        'SELECT id,"authorId",body FROM "CaseComment" WHERE "caseId"=$1 AND visibility=\'CUSTOMER\' ORDER BY "createdAt",id LIMIT 101',
        [caseId],
      )
    ).rows;
    for (const n of comments.slice(0, 100))
      add(
        n.authorId === c.openedBy ? 'ALLEGATION' : 'MERCHANT_ASSERTION',
        n.body,
        { commentId: n.id },
      );
    for (const clause of clauses)
      add('POLICY', clause.text + '\n' + JSON.stringify(clause.rulesJson), {
        policyClauseId: clause.id,
      });
    const timeline = (
      await tx.query(
        'SELECT id,action,"previousStatus","newStatus" FROM "CaseTimelineEvent" WHERE "caseId"=$1 AND visibility=\'CUSTOMER\' AND action NOT LIKE \'AI_%\' ORDER BY "createdAt",id LIMIT 101',
        [caseId],
      )
    ).rows;
    for (const t of timeline.slice(0, 100))
      add(
        'TIMELINE',
        `${t.action}: ${t.previousStatus ?? ''} -> ${t.newStatus ?? ''}`,
        { timelineId: t.id },
      );
    const omissions: string[] = [];
    if (comments.length > 100 || timeline.length > 100)
      omissions.push('DISCUSSION_HISTORY_TRUNCATED');
    if (all.some((e) => !selectedIds.includes(e.id)))
      omissions.push('UNSELECTED_OR_UNAVAILABLE_EVIDENCE');
    return {
      sources,
      caseSummary: { reason: c.reason, requestedOutcome: c.requestedOutcome },
      policy,
      money: {
        gross: String(capture.grossMinor),
        refunded: String(capture.refundedMinor),
        external: String(capture.externalRefundedMinor),
        reserved: String(capture.reservedMinor),
        current:
          capture.reconciliationStatus === 'CURRENT' &&
          capture.providerStatus === 'COMPLETED' &&
          order.paymentState === 'CAPTURED',
      },
      selected,
      omissions,
    } satisfies BaseContext;
  }
  async preview(a: Actor, caseId: string, input: unknown, key: string) {
    const body = aiSelectionSchema.parse(input);
    return this.tx(a, async (tx) => {
      await this.lockSources(tx, a, caseId);
      const old = await replay(tx, a, 'ai-preview:' + caseId, key, body);
      if (old) return old;
      const p = (
        await tx.query(
          'SELECT * FROM "AISharingPolicy" ORDER BY sequence DESC LIMIT 1',
        )
      ).rows[0];
      if (!p?.enabled) fail('AI_SHARING_DISABLED', 503);
      if (
        p.providerId === 'gemini' &&
        !(
          await tx.query(
            'SELECT ("aiSyntheticAuthorized" AND "aiSyntheticAuthorizedVersion"=version) AS "aiSyntheticAuthorized" FROM "Case" WHERE id=$1',
            [caseId],
          )
        ).rows[0]?.aiSyntheticAuthorized
      )
        fail('GEMINI_SYNTHETIC_CASE_REQUIRED', 409);
      const base = await this.base(tx, a, caseId, body.evidenceIds);
      const manifest = (
        await tx.query('SELECT ai_visible_manifest($1) AS manifest', [caseId])
      ).rows[0].manifest;
      const row = (
        await tx.query(
          'INSERT INTO "AIContext"("merchantId","caseId","requestedBy","sharingPolicyId","selectedEvidenceIds",manifest,"baseEncrypted") VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,state',
          [
            a.merchantId,
            caseId,
            a.userId,
            p.id,
            body.evidenceIds,
            JSON.stringify(manifest),
            encryptReceipt(JSON.stringify(base), this.encryptionKey),
          ],
        )
      ).rows[0];
      await tx.query(
        'INSERT INTO "OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES($1,\'AIContext\',$2,\'ai.prepare\',1,$3,$4)',
        [
          a.merchantId,
          row.id,
          JSON.stringify({ contextId: row.id }),
          'ai-prepare-' + row.id,
        ],
      );
      await event(tx, a, caseId, 'AI_PREVIEW_REQUESTED', null, null, {
        contextId: row.id,
      });
      await remember(tx, a, 'ai-preview:' + caseId, key, body, row);
      return row;
    });
  }
  async readPreview(a: Actor, caseId: string, id: string) {
    return this.tx(a, async (tx) => {
      const r = (
        await tx.query(
          'SELECT c.*,p.disclosure,p."modelId",p."providerId",p."executionMode" FROM "AIContext" c JOIN "AISharingPolicy" p ON p.id=c."sharingPolicyId" WHERE c.id=$1 AND c."caseId"=$2',
          [id, caseId],
        )
      ).rows[0];
      if (!r) fail('NOT_FOUND', 404);
      const fresh = (
        await tx.query('SELECT ai_context_fresh($1) AS fresh', [id])
      ).rows[0].fresh;
      return {
        id: r.id,
        state: fresh ? r.state : 'STALE',
        errorCode: r.errorCode,
        sharingPolicyId: r.sharingPolicyId,
        consentHash: r.consentHash,
        disclosure: r.disclosure,
        modelId: r.modelId,
        executionMode: r.executionMode,
        providerId: r.providerId,
        providerRequest:
          r.state === 'READY' && r.requestEncrypted && r.providerId === 'gemini'
            ? geminiWire(
                JSON.parse(
                  decryptReceipt(r.requestEncrypted, this.encryptionKey),
                ),
              )
            : null,
        tokenCountRequest:
          r.state === 'READY' && r.requestEncrypted && r.providerId === 'gemini'
            ? geminiCountWire(
                JSON.parse(
                  decryptReceipt(r.requestEncrypted, this.encryptionKey),
                ),
              )
            : null,
        request:
          r.state === 'READY' && r.requestEncrypted
            ? (JSON.parse(
                decryptReceipt(r.requestEncrypted, this.encryptionKey),
              ) as ProviderInput)
            : null,
        expiresAt: r.expiresAt,
      };
    });
  }
  async consent(
    a: Actor,
    caseId: string,
    body: { contextId: string; sharingPolicyId: string; consentHash: string },
  ) {
    return this.tx(a, async (tx) => {
      const c = await this.lockSources(tx, a, caseId);
      if (c.openedBy !== a.userId) fail('FORBIDDEN', 403);
      const ctx = (
        await tx.query(
          'SELECT * FROM "AIContext" WHERE id=$1 AND "caseId"=$2',
          [body.contextId, caseId],
        )
      ).rows[0];
      if (
        !ctx ||
        ctx.state !== 'READY' ||
        ctx.sharingPolicyId !== body.sharingPolicyId ||
        ctx.consentHash !== body.consentHash ||
        !(await tx.query('SELECT ai_context_fresh($1) AS fresh', [ctx.id]))
          .rows[0].fresh
      )
        fail('CONSENT_PREVIEW_STALE');
      const row =
        (
          await tx.query(
            'INSERT INTO "AIConsent"("merchantId","caseId","contextId","sharingPolicyId","consentHash","actorId") VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT("contextId","actorId","consentHash") DO NOTHING RETURNING id',
            [
              a.merchantId,
              caseId,
              ctx.id,
              ctx.sharingPolicyId,
              ctx.consentHash,
              a.userId,
            ],
          )
        ).rows[0] ??
        (
          await tx.query(
            'SELECT id FROM "AIConsent" WHERE "contextId"=$1 AND "actorId"=$2',
            [ctx.id, a.userId],
          )
        ).rows[0];
      await event(tx, a, caseId, 'AI_SHARING_CONSENTED', null, null, {
        consentId: row.id,
        contextId: ctx.id,
      });
      return row;
    });
  }
  async revoke(a: Actor, caseId: string, consentId: string) {
    return this.tx(a, async (tx) => {
      const c = await this.lockSources(tx, a, caseId);
      if (c.openedBy !== a.userId) fail('FORBIDDEN', 403);
      const consent = (
        await tx.query(
          'SELECT id FROM "AIConsent" WHERE id=$1 AND "caseId"=$2 AND "actorId"=$3',
          [consentId, caseId, a.userId],
        )
      ).rows[0];
      if (!consent) fail('NOT_FOUND', 404);
      await tx.query(
        'INSERT INTO "AIRevocation"("merchantId","consentId","actorId") VALUES($1,$2,$3) ON CONFLICT("consentId") DO NOTHING',
        [a.merchantId, consentId, a.userId],
      );
      await event(tx, a, caseId, 'AI_SHARING_REVOKED', null, null, {
        consentId,
      });
      return { revoked: true };
    });
  }
  async start(
    a: Actor,
    caseId: string,
    consentId: string,
    key: string,
    version: number,
  ) {
    return this.tx(a, async (tx) => {
      if (!(await member(tx, a))) fail('FORBIDDEN', 403);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 5))', [
        a.merchantId,
      ]);
      const c = await this.lockSources(tx, a, caseId);
      const old = await replay(tx, a, 'ai-start:' + caseId, key, { consentId });
      if (old) return old;
      if (c.version !== version) fail('STALE_VERSION');
      const row = (
        await tx.query(
          'SELECT co.*,ctx."catalogEncrypted",ctx."requestEncrypted",p."modelId" FROM "AIConsent" co JOIN "AIContext" ctx ON ctx.id=co."contextId" JOIN "AISharingPolicy" p ON p.id=co."sharingPolicyId" WHERE co.id=$1 AND co."caseId"=$2 AND ctx.state=\'READY\' AND NOT EXISTS(SELECT 1 FROM "AIRevocation" r WHERE r."consentId"=co.id)',
          [consentId, caseId],
        )
      ).rows[0];
      if (
        !row ||
        !(
          await tx.query('SELECT ai_context_fresh($1) AS fresh', [
            row.contextId,
          ])
        ).rows[0].fresh
      )
        fail('CONSENT_MISSING_REVOKED_OR_STALE');
      await tx.query(
        'UPDATE "Analysis" a SET status=\'STALE\',version=version+1,"lastErrorCode"=\'CONSENT_REVOKED\' WHERE a."caseId"=$1 AND a.status IN(\'QUEUED\',\'SUCCEEDED\',\'NEEDS_REVIEW\') AND EXISTS(SELECT 1 FROM "AIRevocation" r WHERE r."consentId"=a."consentId")',
        [caseId],
      );
      const existing = (
        await tx.query(
          'SELECT id,status FROM "Analysis" WHERE "caseId"=$1 AND "snapshotHash"=$2 AND "contextId" IS NOT NULL AND status NOT IN (\'FAILED\',\'STALE\')',
          [caseId, row.consentHash],
        )
      ).rows[0];
      if (existing) return existing;
      const count = (
        await tx.query(
          'SELECT count(*)::int n FROM "Analysis" WHERE "contextId" IS NOT NULL AND "createdAt">now()-interval \'1 minute\'',
        )
      ).rows[0].n;
      if (count >= 5) fail('AI_RATE_LIMIT', 429);
      const active = (
        await tx.query(
          'SELECT id FROM "Analysis" WHERE "caseId"=$1 AND status IN (\'QUEUED\',\'RUNNING\')',
          [caseId],
        )
      ).rows[0];
      if (active) fail('ANALYSIS_ALREADY_ACTIVE');
      const analysis = (
        await tx.query(
          'INSERT INTO "Analysis"("merchantId","caseId","contextId","consentId","requestedBy","snapshotHash","snapshotJson","modelId","promptVersion","schemaVersion","policyEngineVersion","reviewReasons") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'1\',\'complaints-ai-v1\',\'[]\') RETURNING id,status',
          [
            a.merchantId,
            caseId,
            row.contextId,
            consentId,
            a.userId,
            row.consentHash,
            JSON.stringify({
              contextId: row.contextId,
              consentHash: row.consentHash,
            }),
            row.modelId,
            PROMPT_VERSION,
          ],
        )
      ).rows[0];
      const catalog = z
        .array(sourceSchema)
        .parse(
          JSON.parse(decryptReceipt(row.catalogEncrypted, this.encryptionKey)),
        );
      for (const source of catalog) {
        const columns = [
          'caseSourceId',
          'orderId',
          'captureId',
          'commentId',
          'timelineId',
          'policyClauseId',
          'extractionId',
        ];
        const values = columns.map((k) => source.reference[k] ?? null);
        await tx.query(
          'INSERT INTO "AnalysisSource"("merchantId","analysisId","caseId","sourceKey",kind,"caseSourceId","orderId","captureId","commentId","timelineId","policyClauseId","extractionId","recordField","contentHash") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            a.merchantId,
            analysis.id,
            caseId,
            source.key,
            source.kind,
            ...values,
            source.reference.recordField ?? null,
            source.hash,
          ],
        );
      }
      await tx.query(
        'INSERT INTO "OutboxEvent"("merchantId","aggregateType","aggregateId","eventType","schemaVersion","payloadIds","dedupeKey") VALUES($1,\'Analysis\',$2,\'ai.analyze\',1,$3,$4)',
        [
          a.merchantId,
          analysis.id,
          JSON.stringify({ analysisId: analysis.id }),
          'ai-analyze-' + analysis.id,
        ],
      );
      await event(
        tx,
        a,
        caseId,
        'AI_ANALYSIS_REQUESTED',
        null,
        null,
        { analysisId: analysis.id },
        'INTERNAL',
      );
      await remember(tx, a, 'ai-start:' + caseId, key, { consentId }, analysis);
      return analysis;
    });
  }
  async source(a: Actor, analysisId: string, sourceKey: string) {
    return this.tx(a, async (tx) => {
      if (!(await member(tx, a))) fail('NOT_FOUND', 404);
      const row = (
        await tx.query(
          'SELECT ctx."catalogEncrypted",p."executionMode" FROM "Analysis" a JOIN "AIContext" ctx ON ctx.id=a."contextId" JOIN "AISharingPolicy" p ON p.id=ctx."sharingPolicyId" WHERE a.id=$1 AND NOT EXISTS(SELECT 1 FROM "AIRevocation" r WHERE r."consentId"=a."consentId")',
          [analysisId],
        )
      ).rows[0];
      if (!row?.catalogEncrypted) fail('NOT_FOUND', 404);
      const source = z
        .array(sourceSchema)
        .parse(
          JSON.parse(decryptReceipt(row.catalogEncrypted, this.encryptionKey)),
        )
        .find((s) => s.key === sourceKey);
      if (!source) fail('NOT_FOUND', 404);
      return {
        key: source.key,
        kind: source.kind,
        text: source.text,
        page: source.page,
        hash: source.hash,
      };
    });
  }
  async detail(a: Actor, caseId: string, id: string) {
    return this.tx(a, async (tx) => {
      if (!(await member(tx, a))) fail('NOT_FOUND', 404);
      const r = (
        await tx.query(
          'SELECT a.*,ctx."requestEncrypted",ctx."catalogEncrypted",p."executionMode" FROM "Analysis" a JOIN "AIContext" ctx ON ctx.id=a."contextId" JOIN "AISharingPolicy" p ON p.id=ctx."sharingPolicyId" WHERE a.id=$1 AND a."caseId"=$2',
          [id, caseId],
        )
      ).rows[0];
      if (!r) fail('NOT_FOUND', 404);
      const fresh = (
        await tx.query('SELECT ai_context_fresh($1) AS fresh', [r.contextId])
      ).rows[0].fresh;
      const revoked = !!(
        await tx.query('SELECT id FROM "AIRevocation" WHERE "consentId"=$1', [
          r.consentId,
        ])
      ).rows[0];
      const result =
        r.outputEncrypted &&
        ['SUCCEEDED', 'NEEDS_REVIEW', 'STALE'].includes(r.status)
          ? JSON.parse(decryptReceipt(r.outputEncrypted, this.encryptionKey))
          : null;
      const payload = r.requestEncrypted
        ? (JSON.parse(
            decryptReceipt(r.requestEncrypted, this.encryptionKey),
          ) as ProviderInput)
        : null;
      const context = payload
        ? JSON.parse(
            (payload.input[0] as { content: { text: string }[] }).content[0]!
              .text,
          )
        : null;
      return {
        id: r.id,
        status: !fresh ? 'STALE' : revoked ? 'NEEDS_REVIEW' : r.status,
        version: r.version,
        lastErrorCode: r.lastErrorCode,
        fresh,
        revoked,
        modelId: r.modelId,
        executionMode: r.executionMode,
        returnedModel: r.returnedModel,
        promptVersion: r.promptVersion,
        createdAt: r.createdAt,
        providerRequestId: r.providerRequestId,
        usage: r.tokenUsage,
        result: revoked ? null : result,
        constraints: context?.constraints ?? null,
        verifiedFacts:
          context?.sources?.filter(
            (s: AISource) => s.kind === 'TRUSTED_RECORD',
          ) ?? [],
        reviews: (
          await tx.query(
            'SELECT id,sequence,action,reason,recommendation,"createdAt" FROM "AIReview" WHERE "analysisId"=$1 ORDER BY sequence',
            [id],
          )
        ).rows,
      };
    });
  }
  async review(
    a: Actor,
    caseId: string,
    id: string,
    input: unknown,
    version: number,
    key: string,
  ) {
    const body = aiReviewSchema.parse(input);
    return this.tx(a, async (tx) => {
      const role = await member(tx, a);
      if (!role) fail('NOT_FOUND', 404);
      if (body.action !== 'REJECT' && !['OWNER', 'APPROVER'].includes(role))
        fail('FORBIDDEN', 403);
      const c = await this.lockSources(tx, a, caseId);
      const r = (
        await tx.query(
          'SELECT a.*,ctx."requestEncrypted",ctx."selectedEvidenceIds" FROM "Analysis" a JOIN "AIContext" ctx ON ctx.id=a."contextId" WHERE a.id=$1 AND a."caseId"=$2 FOR UPDATE OF a',
          [id, caseId],
        )
      ).rows[0];
      if (!r) fail('NOT_FOUND', 404);
      const old = await replay(tx, a, 'ai-review:' + id, key, body);
      if (old) return old;
      if (r.version !== version) fail('STALE_VERSION');
      if (
        body.action !== 'REJECT' &&
        (!(activeCaseStates as readonly string[]).includes(c.status) ||
          !['SUCCEEDED', 'NEEDS_REVIEW'].includes(r.status) ||
          !(
            await tx.query('SELECT ai_context_fresh($1) AS fresh', [
              r.contextId,
            ])
          ).rows[0].fresh ||
          (
            await tx.query(
              'SELECT id FROM "AIRevocation" WHERE "consentId"=$1',
              [r.consentId],
            )
          ).rows[0])
      )
        fail('ANALYSIS_STALE_OR_UNAVAILABLE');
      let recommendation: unknown = { kind: 'REJECTED' };
      if (body.action !== 'REJECT') {
        if (!r.outputEncrypted) fail('ANALYSIS_UNAVAILABLE');
        const out = JSON.parse(
          decryptReceipt(r.outputEncrypted, this.encryptionKey),
        );
        const envelope = JSON.parse(
          decryptReceipt(r.requestEncrypted, this.encryptionKey),
        ) as ProviderInput;
        const context = JSON.parse(
          (envelope.input[0] as { content: { text: string }[] }).content[0]!
            .text,
        ) as {
          constraints: { candidates: RecommendationCandidate[] };
          omissions: string[];
        };
        const authoritative = await this.base(
          tx,
          a,
          caseId,
          r.selectedEvidenceIds,
        );
        const types = authoritative.selected.map((e) =>
          e.mime.startsWith('image/')
            ? 'IMAGE'
            : e.mime === 'application/pdf'
              ? 'PDF'
              : 'TEXT',
        );
        const expectedConstraints = candidatesFor(authoritative, types, [
          ...authoritative.omissions,
          ...context.omissions,
        ]);
        if (
          hashPayload({ ...expectedConstraints, missingEvidenceTypes: [] }) !==
          hashPayload({ ...context.constraints, missingEvidenceTypes: [] })
        )
          fail('INVALID_POLICY_CONSTRAINTS');
        const chosen = chooseRecommendation(
          context.constraints.candidates,
          body.action === 'REVISE'
            ? (body.candidateId ?? '')
            : out.recommendation.candidateId,
          outputUncertain(out) || context.omissions.length > 0,
        );
        recommendation = {
          ...chosen,
          rationale: body.rationale,
          nonbinding: true,
        };
      }
      const seq = (
        await tx.query(
          'SELECT COALESCE(max(sequence),0)+1 n FROM "AIReview" WHERE "analysisId"=$1',
          [id],
        )
      ).rows[0].n;
      const review = (
        await tx.query(
          'INSERT INTO "AIReview"("merchantId","analysisId","caseId",sequence,"actorId",action,reason,recommendation) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            a.merchantId,
            id,
            caseId,
            seq,
            a.userId,
            body.action,
            body.reason,
            JSON.stringify(recommendation),
          ],
        )
      ).rows[0];
      await tx.query('UPDATE "Analysis" SET version=version+1 WHERE id=$1', [
        id,
      ]);
      await event(
        tx,
        a,
        caseId,
        'AI_INTERNAL_' + body.action,
        null,
        null,
        { analysisId: id, reviewId: review.id, nonbinding: true },
        'INTERNAL',
      );
      await remember(tx, a, 'ai-review:' + id, key, body, review);
      return review;
    });
  }
}
export function preparedRequest(
  base: BaseContext,
  sources: AISource[],
  images: { sourceId: string; dataUrl: string }[],
  availableTypes: string[],
  omissions: string[],
  model = MODEL,
) {
  const constraints = candidatesFor(base, availableTypes, omissions);
  return requestEnvelope(
    {
      caseSummary: base.caseSummary,
      sources: sources.map(({ key, kind, text, page }) => ({
        key,
        kind,
        text,
        page,
      })),
      constraints,
      policy: base.policy,
      omissions,
    },
    images,
    model,
  );
}
