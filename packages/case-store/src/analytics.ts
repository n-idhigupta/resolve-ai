import { analyticsQuerySchema, analyticsSchema } from '@resolveai/shared';
import { PaymentDatabase } from '@resolveai/payment-store';
import { member, fail, type Actor } from './cases.js';
export class AnalyticsStore {
  constructor(readonly db: PaymentDatabase) {}
  async read(a: Actor, input: unknown, now = new Date()) {
    const q = analyticsQuerySchema.parse(input),
      to = new Date(
        Math.min(q.to ? Date.parse(q.to) : now.getTime(), now.getTime()),
      ),
      from = new Date(
        q.from ?? new Date(to.getTime() - 30 * 86400000).toISOString(),
      );
    if (from >= to || to.getTime() - from.getTime() > 366 * 86400000)
      fail('INVALID_ANALYTICS_RANGE', 422);
    return this.db.transaction(
      a.merchantId,
      a.userId,
      async (tx) => {
        if (!(await member(tx, a))) fail('NOT_FOUND', 404);
        const values = [a.merchantId, from, to],
          rows = async (sql: string) => (await tx.query(sql, values)).rows;
        const cases = (
          await rows(
            `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='RESOLVED')::int AS resolved,count(*) FILTER(WHERE status='CLOSED_WITHOUT_AGREEMENT')::int AS closed FROM "Case" WHERE "merchantId"=$1 AND "createdAt">=$2 AND "createdAt"<$3`,
          )
        )[0];
        const statuses = await rows(
          `SELECT status::text,count(*)::int AS count FROM "Case" WHERE "merchantId"=$1 AND "createdAt">=$2 AND "createdAt"<$3 GROUP BY status ORDER BY status`,
        );
        const daily = await rows(
          `SELECT to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*)::int AS count FROM "Case" WHERE "merchantId"=$1 AND "createdAt">=$2 AND "createdAt"<$3 GROUP BY day ORDER BY day`,
        );
        const durations = (
          await rows(
            `SELECT count(*)::int AS samples,avg(extract(epoch FROM("resolvedAt"-"createdAt"))/3600) AS average,percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM("resolvedAt"-"createdAt"))/3600) AS median,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM("resolvedAt"-"createdAt"))/3600) AS p95 FROM "Case" WHERE "merchantId"=$1 AND status='RESOLVED' AND "resolvedAt">=$2 AND "resolvedAt"<$3 AND "resolvedAt">="createdAt"`,
          )
        )[0];
        const captures = (
          await rows(
            `SELECT count(*)::int AS total,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM "Case" c WHERE c."merchantId"=p."merchantId" AND c."orderId"=p."orderId" AND c."createdAt"<=$3))::int AS complaints FROM "Capture" p WHERE p."merchantId"=$1 AND p."verifiedAt" IS NOT NULL AND p."completedAt">=$2 AND p."completedAt"<$3`,
          )
        )[0];
        const settlements = (
          await rows(
            `SELECT count(*)::int AS total,count(*) FILTER(WHERE "authorizedAt" IS NOT NULL)::int AS authorized,count(*) FILTER(WHERE state='COMPLETED')::int AS completed FROM "Settlement" WHERE "merchantId"=$1 AND "acceptedAt">=$2 AND "acceptedAt"<$3`,
          )
        )[0];
        const settlementStatuses = await rows(
          `SELECT state AS status,count(*)::int AS count FROM "Settlement" WHERE "merchantId"=$1 AND "acceptedAt">=$2 AND "acceptedAt"<$3 GROUP BY state ORDER BY state`,
        );
        const approvals = (
          await rows(
            `SELECT count(*)::int AS count FROM "Approval" a JOIN "Proposal" p ON p.id=a."proposalId" WHERE a."merchantId"=$1 AND p.kind IN ('FULL_REFUND','PARTIAL_REFUND') AND a."actorRole"='MERCHANT' AND decision='ACCEPT' AND a."decidedAt">=$2 AND a."decidedAt"<$3`,
          )
        )[0];
        const refunds = await rows(
          `WITH local AS(SELECT r.currency,sum(r."amountMinor") FILTER(WHERE r.state='COMPLETED' AND r."completedAt">=$2 AND r."completedAt"<$3) AS completed,sum(r."amountMinor") FILTER(WHERE r.state='COMPLETED' AND r."completedAt">=$2 AND r."completedAt"<$3 AND a."refundMode"='mock') AS mock,count(*) FILTER(WHERE r.state='COMPLETED' AND r."completedAt">=$2 AND r."completedAt"<$3)::int AS count,sum(r."amountMinor") FILTER(WHERE r.state IN ('READY','IN_FLIGHT','PENDING')) AS pending,sum(r."amountMinor") FILTER(WHERE r.state='UNKNOWN') AS unknown,count(*) FILTER(WHERE r.state IN ('READY','IN_FLIGHT','PENDING'))::int AS pending_count,count(*) FILTER(WHERE r.state='UNKNOWN')::int AS unknown_count FROM "RefundOperation" r JOIN "PaymentAccount" a ON a.id=r."accountId" WHERE r."merchantId"=$1 GROUP BY r.currency),external AS(SELECT e.currency,sum(e."amountMinor") AS completed,count(*)::int AS count FROM "ExternalRefund" e WHERE e."merchantId"=$1 AND e.state='COMPLETED' AND e."completedAt">=$2 AND e."completedAt"<$3 AND NOT EXISTS(SELECT 1 FROM "RefundOperation" r WHERE r."accountId"=e."accountId" AND r."providerRefundId"=e."providerRefundId") GROUP BY e.currency) SELECT coalesce(l.currency,e.currency) AS currency,(coalesce(l.completed,0)+coalesce(e.completed,0))::text AS "completedMinor",coalesce(l.mock,0)::text AS "mockCompletedMinor",(coalesce(l.completed,0)-coalesce(l.mock,0))::text AS "recordedProviderCompletedMinor",coalesce(e.completed,0)::text AS "externalCompletedMinor",coalesce(l.count,0)+coalesce(e.count,0) AS "completedCount",coalesce(l.pending,0)::text AS "pendingMinor",coalesce(l.unknown,0)::text AS "unknownMinor",coalesce(l.pending_count,0) AS "pendingCount",coalesce(l.unknown_count,0) AS "unknownCount" FROM local l FULL JOIN external e ON e.currency=l.currency ORDER BY currency`,
        );
        const ai = (
          await rows(
            `SELECT count(*)::int AS total,count(*) FILTER(WHERE p."executionMode"='mock')::int AS mock FROM "Analysis" a JOIN "AIContext" ctx ON ctx.id=a."contextId" JOIN "AISharingPolicy" p ON p.id=ctx."sharingPolicyId" WHERE a."merchantId"=$1 AND a."createdAt">=$2 AND a."createdAt"<$3`,
          )
        )[0];
        const aiStatuses = await rows(
          `SELECT status::text,count(*)::int AS count FROM "Analysis" WHERE "merchantId"=$1 AND "contextId" IS NOT NULL AND "createdAt">=$2 AND "createdAt"<$3 GROUP BY status ORDER BY status`,
        );
        const recommendations = (
          await rows(
            `SELECT count(*)::int AS count FROM "AIRecommendation" r JOIN "Analysis" a ON a.id=r."analysisId" WHERE a."merchantId"=$1 AND a."createdAt">=$2 AND a."createdAt"<$3`,
          )
        )[0];
        const reviews = (
          await rows(
            `WITH latest AS(SELECT DISTINCT ON(r."analysisId") r.action FROM "AIReview" r JOIN "Analysis" a ON a.id=r."analysisId" WHERE a."merchantId"=$1 AND a."createdAt">=$2 AND a."createdAt"<$3 ORDER BY r."analysisId",r.sequence DESC) SELECT count(*)::int AS reviewed,count(*) FILTER(WHERE action='APPROVE')::int AS approved,count(*) FILTER(WHERE action='REJECT')::int AS rejected,count(*) FILTER(WHERE action='REVISE')::int AS revised FROM latest`,
          )
        )[0];
        const number = (v: unknown) => (v === null ? null : Number(v)),
          rate = (n: number, d: number) =>
            d ? Math.round((n * 10000) / d) : null;
        return analyticsSchema.parse({
          asOf: now.toISOString(),
          from: from.toISOString(),
          to: to.toISOString(),
          complaints: {
            total: cases.total,
            resolved: cases.resolved,
            closedWithoutAgreement: cases.closed,
            resolutionRateBps: rate(cases.resolved, cases.total),
            status: statuses,
            daily,
            durationSamples: durations.samples,
            averageResolutionHours: number(durations.average),
            medianResolutionHours: number(durations.median),
            p95ResolutionHours: number(durations.p95),
            capturedOrders: captures.total,
            capturedOrdersWithComplaint: captures.complaints,
          },
          settlements: {
            ...settlements,
            status: settlementStatuses,
            merchantFinancialAuthorizations: approvals.count,
          },
          refunds,
          ai: {
            analyses: ai.total,
            mockAnalyses: ai.mock,
            recommendations: recommendations.count,
            ...reviews,
            approvalRateBps: rate(
              reviews.approved + reviews.revised,
              reviews.reviewed,
            ),
            status: aiStatuses,
          },
          definitions: [
            'UTC half-open reporting interval; current statuses are observed at asOf.',
            'Resolution rate: resolved complaints divided by complaints opened in the interval; nonfinancial closure is excluded.',
            'Duration: resolvedAt minus createdAt for cases resolved in the interval; sample count, mean, median and p95 are shown.',
            'Capture cohort: verified captures completed in the interval that have a complaint by the observation cutoff.',
            'Settlement cohort: acceptances in the interval, using their current status.',
            'Completed refund totals use completedAt and currency; recorded external refunds are deduplicated by account/provider ID.',
            'Pending and unknown refund exposure includes all dates and never counts as completed.',
            'AI metrics use analyses created in the interval and the latest review per analysis; internal approval is separate from financial authorization.',
            'Mock AI and refunds are synthetic, not provider success or prevention/accuracy claims.',
          ],
        });
      },
      { readOnly: true },
    );
  }
}
