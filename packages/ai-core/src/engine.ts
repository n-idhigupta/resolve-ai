import {
  providerForModel,
  acceptedReturnedModels,
  estimateProviderMicros,
  priceVersion,
} from './selection.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentDatabase,
  encryptReceipt,
  decryptReceipt,
  hashPayload,
} from '@resolveai/payment-store';
import { sourceSchema, validateCitations } from './contracts.js';
import {
  AIProviderError,
  requestEnvelope,
  type AIProvider,
  type ProviderInput,
  type ProviderResult,
} from './provider.js';
import { candidatesFor, type BaseContext } from './service.js';
export const MAX_INPUT = 16000,
  MAX_OUTPUT = 4000,
  RESERVATION_MICROS = 30000;
export const estimatedMicros = (input: number, output: number) =>
  Number((BigInt(input) * 3n + 3n) / 4n + (BigInt(output) * 9n + 1n) / 2n);
export function conservativeTextTokens(input: ProviderInput) {
  const content = (input.input[0] as { content: { type: string }[] }).content;
  if (content.some((c) => c.type === 'input_image'))
    throw Error('IMAGE_PREFLIGHT_REQUIRED');
  return Buffer.byteLength(JSON.stringify(input), 'utf8') + 2048;
}
export class AnalysisEngine {
  constructor(
    readonly db: PaymentDatabase,
    readonly provider: AIProvider,
    readonly key: string,
  ) {}
  async validConsent(
    tx: import('@resolveai/payment-store').Tx,
    contextId: string,
    consentId: string,
  ) {
    return (
      !!(
        await tx.query(
          'SELECT c.id FROM "AIConsent" c JOIN "AIContext" ctx ON ctx.id=c."contextId" WHERE c.id=$1 AND c."contextId"=$2 AND c."sharingPolicyId"=ctx."sharingPolicyId" AND c."consentHash"=ctx."consentHash" AND ctx.state=\'READY\' AND NOT EXISTS(SELECT 1 FROM "AIRevocation" r WHERE r."consentId"=c.id)',
          [consentId, contextId],
        )
      ).rows[0] &&
      !!(await tx.query('SELECT ai_context_fresh($1) AS fresh', [contextId]))
        .rows[0].fresh
    );
  }
  async run(merchantId: string, id: string) {
    const lease = randomUUID();
    let row;
    try {
      row = await this.db.transaction(merchantId, null, async (tx) => {
        const running = (
          await tx.query(
            'SELECT id FROM "Analysis" WHERE status=\'RUNNING\' AND id<>$1 AND "leaseUntil">now()',
            [id],
          )
        ).rows[0];
        if (running) return null;
        return (
          await tx.query(
            'UPDATE "Analysis" SET status=\'RUNNING\',"leaseOwner"=$3,"leaseUntil"=now()+interval \'3 minutes\',version=version+1 WHERE id=$1 AND "merchantId"=$2 AND "contextId" IS NOT NULL AND status IN (\'QUEUED\',\'RUNNING\') AND "postAttempts"<3 AND "nextAttemptAt"<=now() AND ("leaseUntil" IS NULL OR "leaseUntil"<now()) RETURNING *',
            [id, merchantId, lease],
          )
        ).rows[0];
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === '23505')
        return;
      throw e;
    }
    if (!row) return;
    let usageId: string | undefined,
      sent = false,
      result: ProviderResult | undefined;
    try {
      const context = await this.db.transaction(
        merchantId,
        null,
        async (tx) => {
          if (!(await this.validConsent(tx, row.contextId, row.consentId)))
            throw Error('CONSENT_REVOKED_OR_STALE');
          return (
            await tx.query(
              'SELECT ctx.*,p."dailyBudgetMicros",p."modelId",p."executionMode" FROM "AIContext" ctx JOIN "AISharingPolicy" p ON p.id=ctx."sharingPolicyId" WHERE ctx.id=$1',
              [row.contextId],
            )
          ).rows[0];
        },
      );
      if (
        (context.executionMode ?? 'external') !==
        (this.provider.executionMode ?? 'external')
      )
        throw Error('PROVIDER_EXECUTION_MODE_MISMATCH');
      if (
        this.provider.executionMode === 'mock' &&
        !(await this.db.transaction(
          merchantId,
          null,
          async (tx) =>
            (
              await tx.query('SELECT mock_context_allowed($1) AS allowed', [
                row.contextId,
              ])
            ).rows[0]?.allowed,
        ))
      )
        throw Error('MOCK_CONTEXT_NOT_AUTHORIZED');
      const request = JSON.parse(
        decryptReceipt(context.requestEncrypted, this.key),
      ) as ProviderInput;
      const expected = requestEnvelope({}, [], context.modelId);
      if (
        this.provider.id &&
        this.provider.id !== providerForModel(context.modelId)
      )
        throw Error('PROVIDER_CONFIGURATION_MISMATCH');
      if (
        request.model !== context.modelId ||
        hashPayload({ ...request, input: [] }) !==
          hashPayload({ ...expected, input: [] }) ||
        request.input.length !== 1
      )
        throw Error('INVALID_PROVIDER_ENVELOPE');
      const sources = z
        .array(sourceSchema)
        .parse(JSON.parse(decryptReceipt(context.catalogEncrypted, this.key)));
      const publicContext = JSON.parse(
        (request.input[0] as { content: { text: string }[] }).content[0]!.text,
      );
      const authoritative = JSON.parse(
        decryptReceipt(context.baseEncrypted, this.key),
      ) as BaseContext;
      const types = authoritative.selected.map((e) =>
        e.mime.startsWith('image/')
          ? 'IMAGE'
          : e.mime === 'application/pdf'
            ? 'PDF'
            : 'TEXT',
      );
      const expectedConstraints = candidatesFor(authoritative, types, [
        ...authoritative.omissions,
        ...publicContext.omissions,
      ]);
      if (
        hashPayload({ ...expectedConstraints, missingEvidenceTypes: [] }) !==
        hashPayload({ ...publicContext.constraints, missingEvidenceTypes: [] })
      )
        throw Error('INVALID_POLICY_CONSTRAINTS');
      usageId = await this.db.transaction(merchantId, null, async (tx) => {
        await tx.query(
          'INSERT INTO "AIBudget"("merchantId",day) VALUES($1,current_date) ON CONFLICT DO NOTHING',
          [merchantId],
        );
        const budget = (
          await tx.query(
            'SELECT * FROM "AIBudget" WHERE "merchantId"=$1 AND day=current_date FOR UPDATE',
            [merchantId],
          )
        ).rows[0];
        const attempt = (
          await tx.query(
            'SELECT "postAttempts","leaseOwner" FROM "Analysis" WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (attempt.leaseOwner !== lease) throw Error('LEASE_LOST');
        const total = (
          await tx.query(
            'SELECT COALESCE(sum("reservedMicros"),0)::text n FROM "AIUsage" WHERE "analysisId"=$1',
            [id],
          )
        ).rows[0].n;
        if (
          attempt.postAttempts >= 3 ||
          BigInt(total) + BigInt(RESERVATION_MICROS) > 500000n ||
          BigInt(budget.committedMicros) + BigInt(RESERVATION_MICROS) >
            BigInt(context.dailyBudgetMicros)
        )
          throw Error('AI_BUDGET_EXCEEDED');
        await tx.query(
          'UPDATE "AIBudget" SET "committedMicros"="committedMicros"+$2 WHERE "merchantId"=$1 AND day=current_date',
          [merchantId, RESERVATION_MICROS],
        );
        const usage = (
          await tx.query(
            'INSERT INTO "AIUsage"("merchantId","analysisId",attempt,"reservedMicros","priceVersion") VALUES($1,$2,$3,$4,$5) RETURNING id',
            [
              merchantId,
              id,
              attempt.postAttempts + 1,
              RESERVATION_MICROS,
              this.provider.executionMode === 'mock'
                ? 'mock-local-no-charge-v1'
                : priceVersion(context.modelId),
            ],
          )
        ).rows[0];
        await tx.query(
          'UPDATE "Analysis" SET "postAttempts"="postAttempts"+1 WHERE id=$1',
          [id],
        );
        return usage.id as string;
      });
      if (
        !(await this.db.transaction(merchantId, null, async (tx) => {
          if (!(await this.validConsent(tx, row.contextId, row.consentId)))
            return false;
          await tx.query(
            'UPDATE "AIUsage" SET "preflightAuthorizedAt"=now() WHERE id=$1',
            [usageId],
          );
          return true;
        }))
      )
        throw Error('CONSENT_REVOKED_OR_STALE');
      let tokens: number;
      try {
        tokens = await this.provider.countInputTokens(request);
      } catch (e) {
        if (
          e instanceof AIProviderError &&
          [
            'PROVIDER_HTTP_404',
            'PROVIDER_HTTP_405',
            'PROVIDER_HTTP_501',
          ].includes(e.code)
        )
          tokens = conservativeTextTokens(request);
        else throw e;
      }
      if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_INPUT)
        throw Error('INPUT_BUDGET_EXCEEDED');
      if (
        !(await this.db.transaction(merchantId, null, async (tx) => {
          if (!(await this.validConsent(tx, row.contextId, row.consentId)))
            return false;
          await tx.query(
            'UPDATE "AIUsage" SET "dispatchAuthorizedAt"=now() WHERE id=$1',
            [usageId],
          );
          return true;
        }))
      )
        throw Error('CONSENT_REVOKED_OR_STALE');
      sent = true;
      result = await this.provider.analyze(request);
      if (!acceptedReturnedModels(request.model).includes(result.model))
        throw Error('UNEXPECTED_PROVIDER_MODEL');
      const validated = validateCitations(
        result.output,
        sources,
        publicContext.constraints.candidates,
      );
      if (
        publicContext.omissions.length > 0 &&
        !['REQUEST_MORE_INFORMATION', 'ESCALATE_TO_HUMAN'].includes(
          validated.candidate.kind,
        )
      )
        throw Error('OMITTED_EVIDENCE_REQUIRES_REVIEW');
      if (result.inputTokens > MAX_INPUT || result.outputTokens > MAX_OUTPUT)
        throw Error('PROVIDER_USAGE_EXCEEDED');
      await this.db.transaction(merchantId, null, async (tx) => {
        const fresh = await this.validConsent(tx, row.contextId, row.consentId);
        const live = (
          await tx.query(
            'SELECT "leaseOwner" FROM "Analysis" WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (live.leaseOwner !== lease) throw Error('LEASE_LOST');
        const revoked = !!(
          await tx.query('SELECT id FROM "AIRevocation" WHERE "consentId"=$1', [
            row.consentId,
          ])
        ).rows[0];
        const status = !fresh
          ? 'STALE'
          : validated.uncertain
            ? 'NEEDS_REVIEW'
            : 'SUCCEEDED';
        await tx.query(
          'UPDATE "Analysis" SET status=$3::"AnalysisState","outputEncrypted"=$4,"returnedModel"=$5,"providerRequestId"=$6,"latencyMs"=$7,"tokenUsage"=$8,"completedAt"=now(),"leaseUntil"=NULL,version=version+1,"lastErrorCode"=$9,"outputHash"=$10 WHERE id=$1 AND "leaseOwner"=$2',
          [
            id,
            lease,
            status,
            encryptReceipt(JSON.stringify(validated.output), this.key),
            result!.model,
            result!.requestId,
            result!.latencyMs,
            JSON.stringify({
              input: result!.inputTokens,
              output: result!.outputTokens,
              executionMode: this.provider.executionMode ?? 'external',
              estimatedMicros:
                this.provider.executionMode === 'mock'
                  ? 0
                  : estimateProviderMicros(
                      result!.inputTokens,
                      result!.outputTokens,
                      request.model,
                    ),
            }),
            revoked ? 'CONSENT_REVOKED_AFTER_SEND' : null,
            hashPayload(validated.output),
          ],
        );
        if (fresh && !revoked) {
          await tx.query(
            'INSERT INTO "AIRecommendation"("merchantId","analysisId","caseId",candidate,constraints) VALUES($1,$2,$3,$4,$5)',
            [
              merchantId,
              id,
              row.caseId,
              JSON.stringify({ ...validated.candidate, nonbinding: true }),
              JSON.stringify(publicContext.constraints),
            ],
          );
          for (const finding of validated.output.findings) {
            const f = (
              await tx.query(
                'INSERT INTO "Finding"("merchantId","analysisId",kind,statement,"certaintyBand","reviewStatus") VALUES($1,$2,$3,$4,\'UNVERIFIED\',\'MERCHANT_REVIEW_REQUIRED\') RETURNING id',
                [
                  merchantId,
                  id,
                  finding.kind,
                  'Encrypted finding ' + finding.id,
                ],
              )
            ).rows[0];
            for (const alias of finding.sourceIds) {
              const source = (
                await tx.query(
                  'SELECT id FROM "AnalysisSource" WHERE "analysisId"=$1 AND "sourceKey"=$2',
                  [id, alias],
                )
              ).rows[0];
              await tx.query(
                'INSERT INTO "FindingReference"("merchantId","findingId","analysisId","analysisSourceId",start,"end","quoteHash") VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                  merchantId,
                  f.id,
                  id,
                  source.id,
                  finding.start,
                  finding.end,
                  finding.quote === null ? null : hashPayload(finding.quote),
                ],
              );
            }
          }
        }
        await tx.query(
          'INSERT INTO "AuditEvent"("merchantId","aggregateType","aggregateId","actorType",action,visibility,"correlationId","redactedMetadata") VALUES($1,\'Analysis\',$2,\'AI_WORKER\',\'AI_RESULT_VALIDATED\',\'INTERNAL\',$3,$4)',
          [
            merchantId,
            id,
            result!.requestId ?? id,
            JSON.stringify({ status, nonbinding: true }),
          ],
        );
      });
    } catch (e) {
      const code =
        e instanceof AIProviderError
          ? e.code
          : e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : 'INVALID_MODEL_OUTPUT';
      const retry =
        e instanceof AIProviderError && e.transient && row.postAttempts < 2;
      await this.db.transaction(merchantId, null, (tx) =>
        tx.query(
          'UPDATE "Analysis" SET status=$3::"AnalysisState","lastErrorCode"=$4,"leaseUntil"=NULL,"nextAttemptAt"=now()+($5::int*interval \'1 second\'),version=version+1,"completedAt"=CASE WHEN $3=\'QUEUED\' THEN NULL ELSE now() END WHERE id=$1 AND "leaseOwner"=$2',
          [
            id,
            lease,
            code === 'CONSENT_REVOKED_OR_STALE'
              ? 'STALE'
              : retry
                ? 'QUEUED'
                : sent
                  ? 'NEEDS_REVIEW'
                  : 'FAILED',
            code,
            retry
              ? Math.max(
                  2 ** (row.postAttempts + 1),
                  e instanceof AIProviderError ? e.retryAfterSeconds : 0,
                )
              : 0,
          ],
        ),
      );
    } finally {
      if (usageId) {
        const actual =
          this.provider.executionMode === 'mock'
            ? 0
            : result
              ? estimateProviderMicros(
                  result.inputTokens,
                  result.outputTokens,
                  row.modelId,
                )
              : sent
                ? null
                : 0;
        await this.db.transaction(merchantId, null, async (tx) => {
          const usage = (
            await tx.query('SELECT * FROM "AIUsage" WHERE id=$1 FOR UPDATE', [
              usageId,
            ])
          ).rows[0];
          if (!usage || usage.status !== 'RESERVED') return;
          await tx.query(
            'UPDATE "AIUsage" SET status=$2,"chargedMicros"=$3,"usageJson"=$4,"requestId"=$5 WHERE id=$1',
            [
              usageId,
              actual === null ? 'UNKNOWN' : 'KNOWN',
              actual,
              result
                ? JSON.stringify({
                    input: result.inputTokens,
                    output: result.outputTokens,
                  })
                : null,
              result?.requestId ?? null,
            ],
          );
          if (actual !== null)
            await tx.query(
              'UPDATE "AIBudget" SET "committedMicros"=GREATEST(0,"committedMicros"+$3-$4) WHERE "merchantId"=$1 AND day=$2::date',
              [merchantId, usage.createdAt, actual, usage.reservedMicros],
            );
        });
      }
    }
  }
}
